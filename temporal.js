'use strict';

// Temporal + provenance fact katmani: "bir bilgi ne zaman dogruydu, kim yazdi,
// neyle degisti, ne kadar guvenilir" sorularini cevaplayan kayit tipi.
// Canonical depo memory.js'in state.json'i; buradaki fonksiyonlar state
// uzerinde calisan yardimcilardir (dosya IO'su yok). memory.js kendi redaksiyon
// ve normalizasyon araclarini createTemporal ile buraya enjekte eder; boylece
// gizli deger filtreleri tek yerden yonetilir ve modul dongusu olusmaz.

const FACT_STATUSES = new Set(['active', 'superseded', 'invalidated', 'disputed', 'forgotten']);
const ASSERTION_TYPES = new Set(['user', 'agent', 'imported', 'inferred', 'system']);
const EVIDENCE_LEVELS = new Set(['direct', 'derived', 'unverified']);
// Tek degerli yuklemler: ayni ozne icin yeni deger eskisini gecersiz kilar
// ("kullanici koyu tema kullanir" -> "acik tema"). Diger yuklemler (karar-verdi
// gibi) cok degerlidir: farkli degerler yan yana yasar, yalniz ayni degerin
// tekrari tazeleme sayilir. topic alani slotu elle daraltmak icindir
// ("kullanici|tercih-eder|tema" gibi).
const SINGLE_VALUED_PREDICATES = new Set(['tercih-eder', 'kullanir', 'durum', 'sahip']);
// 100k manuel scale modu canonical JSON + yerel indeksle desteklenir; 120k
// uzeri eski tarihsel kayitlar kontrollu budanir, aktif bilgi korunur.
const MAX_FACTS = 120000;
// Yeni bilgi mevcut aktif bilgiden bu kadar daha dusuk guvendeyse otomatik
// ezmek yerine ihtilafli (disputed) olarak gorunur kalir.
const DISPUTE_CONFIDENCE_MARGIN = 0.15;

function createTemporal(tools) {
  const { clamp, nowIso, randomId, safeText, safeId, safeList, redact, normalizeForSearch } = tools;

  function safeIso(value, fallback = '') {
    const time = Date.parse(String(value ?? ''));
    return Number.isFinite(time) ? new Date(time).toISOString() : fallback;
  }

  function normalizePredicate(value) {
    return normalizeForSearch(value).replace(/\s+/g, '-').slice(0, 80);
  }

  function redactedText(value, max) {
    const cleaned = redact(value);
    return { text: safeText(cleaned.text, max), redactions: cleaned.redactions };
  }

  function redactedList(value, maxItems = 40, maxText = 500) {
    let redactions = 0;
    const items = safeList(value, maxItems, maxText).map((item) => {
      const cleaned = redactedText(item, maxText);
      redactions += cleaned.redactions;
      return cleaned.text;
    }).filter(Boolean);
    return { items, redactions };
  }

  function hasVerifiableSource(source = {}) {
    return !!(source.sessionId || source.checkpointId || source.eventId || source.noteId || source.file);
  }

  function evidenceRank(value) {
    return value === 'direct' ? 3 : value === 'derived' ? 2 : 1;
  }

  function factSlot(fact) {
    const scope = fact.projectId || 'global';
    const subject = normalizeForSearch(fact.subject).slice(0, 120);
    const predicate = normalizePredicate(fact.predicate);
    if (fact.topic) return `${scope}|${subject}|${predicate}|topic:${normalizeForSearch(fact.topic).slice(0, 80)}`;
    if (SINGLE_VALUED_PREDICATES.has(predicate)) return `${scope}|${subject}|${predicate}`;
    return `${scope}|${subject}|${predicate}|${normalizeForSearch(fact.object || fact.value).slice(0, 160)}`;
  }

  function sameValue(a, b) {
    return normalizeForSearch(`${a.object} ${a.value}`) === normalizeForSearch(`${b.object} ${b.value}`);
  }

  function tokenSimilarity(a, b) {
    const left = new Set(normalizeForSearch(a).split(/\s+/).filter((token) => token.length > 1));
    const right = new Set(normalizeForSearch(b).split(/\s+/).filter((token) => token.length > 1));
    if (!left.size || !right.size) return 0;
    let intersection = 0;
    for (const token of left) if (right.has(token)) intersection++;
    return intersection / (left.size + right.size - intersection);
  }

  // Kesin slot eslesmeleri upsert'in mevcut supersede kuralina aittir. Bu
  // yardimci yalnizca yakin ama ayni olmayan slotlari insan/ajan onayina sunar.
  function suggestFactConflicts(state, candidate, input = {}) {
    const threshold = clamp(input.threshold, 0.7, 0.95, 0.78);
    const suggestions = [];
    for (const existing of state.facts) {
      if (!existing || existing.id === candidate.id || !['active', 'disputed'].includes(existing.status)) continue;
      if ((existing.projectId || null) !== (candidate.projectId || null)) continue;
      if (existing.slot === candidate.slot || (candidate.conflictDismissals || []).includes(existing.id)) continue;
      const subject = normalizeForSearch(existing.subject) === normalizeForSearch(candidate.subject)
        ? 1 : tokenSimilarity(existing.subject, candidate.subject);
      const predicate = normalizePredicate(existing.predicate) === normalizePredicate(candidate.predicate)
        ? 1 : tokenSimilarity(existing.predicate, candidate.predicate);
      if (subject < 0.6 || predicate < 0.8) continue;
      const topic = existing.topic || candidate.topic
        ? tokenSimilarity(existing.topic, candidate.topic) : 1;
      const value = tokenSimilarity(`${existing.object} ${existing.value}`, `${candidate.object} ${candidate.value}`);
      // Farkli konular tamamen alakasizsa, ortak bir deger sinyali olmadan
      // sirf ayni ozne/yuklem yuzunden oneride bulunma.
      if (topic < 0.2 && value < 0.25) continue;
      const similarity = subject * 0.4 + predicate * 0.3 + topic * 0.15 + value * 0.15;
      if (similarity < threshold) continue;
      const reasons = ['ayni kapsam', 'benzer özne', 'aynı yüklem'];
      if (topic >= 0.3) reasons.push('benzer konu');
      if (value >= 0.3) reasons.push('örtüşen değer sözcükleri');
      const suggestedAction = similarity >= 0.92 && value < 0.5 ? 'supersede'
        : candidate.confidence <= 0.35 ? 'dispute' : 'keep-separate';
      suggestions.push({
        fact: factSummary(existing),
        similarity: Number(similarity.toFixed(3)),
        reasons,
        suggestedAction,
      });
    }
    return suggestions.sort((a, b) => b.similarity - a.similarity).slice(0, clamp(input.limit, 1, 10, 5));
  }

  function validAt(fact, timeMs) {
    const from = Date.parse(fact.validFrom || fact.recordedAt || 0) || 0;
    const to = fact.validTo ? Date.parse(fact.validTo) : Infinity;
    return from <= timeMs && timeMs < to;
  }

  function earliestIso(left, right) {
    const leftMs = left ? Date.parse(left) : Infinity;
    const rightMs = right ? Date.parse(right) : Infinity;
    const earliest = Math.min(Number.isFinite(leftMs) ? leftMs : Infinity, Number.isFinite(rightMs) ? rightMs : Infinity);
    return Number.isFinite(earliest) ? new Date(earliest).toISOString() : null;
  }

  function upsertFact(state, input = {}, source = {}, project = null) {
    const at = nowIso();
    const globalScope = input.scope === 'global';
    const subjectValue = redact(input.subject);
    const objectValue = redact(input.object);
    const readable = redact(input.value);
    const topicValue = redactedText(input.topic, 80);
    const predicateValue = redactedText(input.predicate, 80);
    const agentValue = redactedText(source.agent || input.agent, 80);
    const clientValue = redactedText(source.client || input.client, 80);
    const noteValue = redactedText(source.noteId || input.noteId, 220);
    const fileValue = redactedText(source.file || input.file, 700);
    const tagValues = redactedList(input.tags, 16, 50);
    const observedAt = safeIso(input.observedAt, at);
    const sourceValue = {
      agent: agentValue.text,
      client: clientValue.text,
      sessionId: safeId(source.sessionId || input.sessionId),
      checkpointId: safeId(source.checkpointId || input.checkpointId),
      eventId: safeId(source.eventId || input.eventId),
      noteId: noteValue.text,
      file: fileValue.text,
    };
    const requestedAssertion = safeText(input.assertionType, 24).toLowerCase();
    const assertionType = ASSERTION_TYPES.has(requestedAssertion)
      ? requestedAssertion
      : input.migrationKey ? 'imported'
        : (sourceValue.sessionId || sourceValue.checkpointId || sourceValue.eventId || (sourceValue.agent && sourceValue.agent !== 'user')) ? 'agent'
          : 'user';
    if (assertionType === 'user') sourceValue.agent = 'user';
    const requestedEvidence = safeText(input.evidenceLevel, 24).toLowerCase();
    let evidenceLevel = EVIDENCE_LEVELS.has(requestedEvidence)
      ? requestedEvidence
      : assertionType === 'user' ? 'direct'
        : (sourceValue.checkpointId || sourceValue.eventId || input.migrationKey) ? 'derived'
          : hasVerifiableSource(sourceValue) ? 'direct' : 'unverified';
    const unsupportedAssertion = assertionType !== 'user' && !hasVerifiableSource(sourceValue);
    if (unsupportedAssertion) evidenceLevel = 'unverified';
    const fact = {
      id: randomId('fact'),
      projectId: globalScope ? null : (project?.id || safeId(input.projectId) || null),
      projectName: globalScope ? null : safeText(project?.name || input.project, 120) || null,
      workspace: globalScope ? '' : safeText(project?.workspace || input.workspace, 700),
      subject: safeText(subjectValue.text, 200),
      predicate: predicateValue.text || 'durum',
      object: safeText(objectValue.text, 700),
      value: safeText(readable.text, 2000) || safeText(objectValue.text, 700),
      topic: topicValue.text || null,
      status: 'active',
      confidence: unsupportedAssertion ? Math.min(0.35, clamp(input.confidence, 0, 1, 0.35)) : clamp(input.confidence, 0, 1, 0.7),
      assertionType,
      evidenceLevel,
      observedAt,
      recordedAt: at,
      validFrom: safeIso(input.validFrom, observedAt),
      validTo: safeIso(input.validTo, '') || null,
      source: sourceValue,
      supersedes: [],
      supersededBy: [],
      contradictionGroup: null,
      tags: tagValues.items,
      redactions: subjectValue.redactions + objectValue.redactions + readable.redactions
        + topicValue.redactions + predicateValue.redactions + agentValue.redactions + clientValue.redactions
        + noteValue.redactions + fileValue.redactions + tagValues.redactions,
    };
    if (input.migrationKey) fact.migrationKey = safeText(input.migrationKey, 160);
    if (!normalizeForSearch(fact.subject)) throw new Error('fact icin ozne (subject) gerekli');
    if (!fact.object && !fact.value) throw new Error('fact icin deger (object/value) gerekli');
    fact.slot = factSlot(fact);
    const conflictSuggestions = suggestFactConflicts(state, fact);
    if (conflictSuggestions.length) {
      fact.conflictSuggestions = conflictSuggestions.map((item) => ({
        factId: item.fact.id,
        similarity: item.similarity,
        reasons: item.reasons,
        suggestedAction: item.suggestedAction,
        status: 'pending',
      }));
    }

    const explicitTargets = safeList(input.supersedes, 12, 120).map((id) => safeId(id)).filter(Boolean);
    const slotMates = state.facts.filter((item) => item.slot === fact.slot
      && ['active', 'disputed'].includes(item.status));
    // Ikiz arama: once guncel kayitlar, sonra "o tarihte zaten boyleydi"
    // durumlari — ayni deger, gecerlilik penceresi icinde yeniden gozlemlendiyse
    // yeni versiyon acilmaz (5 sn tolerans es zamanli kayitlar icindir).
    const withinValidity = (item, iso) => {
      const time = Date.parse(iso);
      const from = Date.parse(item.validFrom || item.recordedAt || 0) || 0;
      const to = item.validTo ? Date.parse(item.validTo) : Infinity;
      return time >= from - 5000 && time < to;
    };
    const twin = !explicitTargets.length && input.dispute !== true
      ? (slotMates.find((item) => sameValue(item, fact))
        || state.facts.find((item) => item.slot === fact.slot && item.status !== 'forgotten'
          && sameValue(item, fact) && withinValidity(item, fact.validFrom)))
      : null;
    if (twin) {
      // Ayni bilgi yeniden gozlemlendi: versiyon sisirmeden tazele.
      twin.observedAt = fact.observedAt;
      twin.confidence = Math.max(twin.confidence ?? 0, fact.confidence);
      twin.redactions = (twin.redactions || 0) + fact.redactions;
      if (fact.tags.length) twin.tags = [...new Set([...(twin.tags || []), ...fact.tags])].slice(0, 16);
      if (fact.migrationKey) twin.migrationKey = twin.migrationKey || fact.migrationKey;
      if (hasVerifiableSource(fact.source)) twin.source = fact.source;
      if (evidenceRank(fact.evidenceLevel) >= evidenceRank(twin.evidenceLevel)) {
        twin.assertionType = fact.assertionType;
        twin.evidenceLevel = fact.evidenceLevel;
      }
      return { fact: twin, refreshed: true, superseded: [], affectedIds: [twin.id], conflictSuggestions };
    }

    const conflicts = explicitTargets.length
      ? state.facts.filter((item) => explicitTargets.includes(item.id) && item.status !== 'forgotten')
      : slotMates;
    const strongest = conflicts
      .filter((item) => item.status === 'active')
      .reduce((best, item) => (!best || (item.confidence ?? 0) > (best.confidence ?? 0) ? item : best), null);
    const autoDispute = !explicitTargets.length && strongest
      && fact.confidence + DISPUTE_CONFIDENCE_MARGIN < (strongest.confidence ?? 0);
    if (input.dispute === true || autoDispute || unsupportedAssertion
      || (conflictSuggestions.length && fact.confidence <= 0.35)) {
      const group = conflicts.map((item) => item.contradictionGroup).find(Boolean) || randomId('cg');
      fact.status = 'disputed';
      fact.contradictionGroup = group;
      for (const item of conflicts) item.contradictionGroup = item.contradictionGroup || group;
    } else {
      for (const item of conflicts) {
        if (Date.parse(fact.validFrom) < Date.parse(item.validFrom || item.recordedAt || 0)) {
          // Geriye donuk kayit: guncel bilgi taze kalir, yeni kayit tarihsel dusar.
          fact.status = 'superseded';
          fact.validTo = earliestIso(fact.validTo, item.validFrom);
          fact.supersededBy = [...new Set([...fact.supersededBy, item.id])];
          item.supersedes = [...new Set([...(item.supersedes || []), fact.id])];
        } else {
          item.status = 'superseded';
          item.validTo = earliestIso(item.validTo, fact.validFrom);
          item.supersededBy = [...new Set([...(item.supersededBy || []), fact.id])];
          fact.supersedes = [...new Set([...fact.supersedes, item.id])];
        }
      }
    }
    state.facts.push(fact);
    return {
      fact, refreshed: false, superseded: fact.supersedes,
      affectedIds: [...new Set([fact.id, ...conflicts.map((item) => item.id)])],
      conflictSuggestions,
    };
  }

  function resolveFactConflict(state, input = {}) {
    const fact = state.facts.find((item) => item.id === safeId(input.id));
    const target = state.facts.find((item) => item.id === safeId(input.targetId));
    if (!fact || !target) throw new Error('fact veya celiski hedefi bulunamadi');
    if (fact.id === target.id) throw new Error('fact kendi kendisiyle celiski cozemez');
    if (fact.status === 'forgotten' || target.status === 'forgotten') throw new Error('unutulmus fact icin celiski cozumlenemez');
    if ((fact.projectId || null) !== (target.projectId || null)) throw new Error('farkli proje factleri birlestirilemez');
    const action = safeText(input.action, 30);
    if (!['supersede', 'dispute', 'keep-separate'].includes(action)) throw new Error('gecersiz celiski aksiyonu');
    if (action === 'supersede') {
      target.status = 'superseded';
      target.validTo = earliestIso(target.validTo, fact.validFrom || fact.recordedAt || nowIso());
      target.supersededBy = [...new Set([...(target.supersededBy || []), fact.id])];
      fact.supersedes = [...new Set([...(fact.supersedes || []), target.id])];
      if (fact.evidenceLevel !== 'unverified') fact.status = 'active';
    } else if (action === 'dispute') {
      const group = fact.contradictionGroup || target.contradictionGroup || randomId('cg');
      fact.status = 'disputed';
      fact.contradictionGroup = group;
      target.contradictionGroup = group;
    } else {
      fact.conflictDismissals = [...new Set([...(fact.conflictDismissals || []), target.id])].slice(0, 40);
    }
    fact.conflictSuggestions = (fact.conflictSuggestions || []).map((item) => item.factId === target.id
      ? { ...item, status: action === 'keep-separate' ? 'kept-separate' : 'resolved', resolvedAction: action, resolvedAt: nowIso() }
      : item);
    return { fact, target, action, affectedIds: [fact.id, target.id] };
  }

  function selectFacts(state, input = {}) {
    const asOfMs = input.asOf ? Date.parse(input.asOf) : null;
    const subject = normalizeForSearch(input.subject || '');
    const predicate = normalizePredicate(input.predicate || '');
    const query = normalizeForSearch(input.query || '');
    const candidateIds = input.candidateIds instanceof Set ? input.candidateIds : null;
    const candidateOrder = input.candidateOrder && typeof input.candidateOrder === 'object' ? input.candidateOrder : null;
    return state.facts
      .filter((fact) => {
        if (candidateIds && !candidateIds.has(fact.id)) return false;
        if (fact.status === 'forgotten' && !input.includeForgotten) return false;
        if (!input.allProjects && fact.projectId && fact.projectId !== input.projectId) return false;
        if (subject && !normalizeForSearch(fact.subject).includes(subject)) return false;
        if (predicate && normalizePredicate(fact.predicate) !== predicate) return false;
        if (input.assertionType && fact.assertionType !== input.assertionType) return false;
        if (input.evidenceLevel && fact.evidenceLevel !== input.evidenceLevel) return false;
        if (input.sourceAgent && fact.source?.agent !== input.sourceAgent) return false;
        if (query && !normalizeForSearch(`${fact.subject} ${fact.predicate} ${fact.object} ${fact.value} ${(fact.tags || []).join(' ')}`).includes(query)) return false;
        if (input.status) return fact.status === input.status;
        if (Number.isFinite(asOfMs)) return validAt(fact, asOfMs);
        if (input.includeHistorical) return true;
        return fact.status === 'active' || fact.status === 'disputed';
      })
      .sort((a, b) => candidateOrder
        ? (candidateOrder[a.id] ?? Number.MAX_SAFE_INTEGER) - (candidateOrder[b.id] ?? Number.MAX_SAFE_INTEGER)
        : Date.parse(b.validFrom || b.recordedAt || 0) - Date.parse(a.validFrom || a.recordedAt || 0))
      .slice(0, input.internal
        ? clamp(input.limit, 1, 2500, 400)
        : clamp(input.limit, 1, 500, 100));
  }

  function factCandidates(state, input = {}) {
    return selectFacts(state, {
      ...input, status: input.status || '', internal: true,
      limit: input.candidateIds ? Math.min(2500, input.candidateIds.size || 2000) : 400,
    }).map((fact) => ({
      id: fact.id,
      sourceType: 'fact',
      kind: 'fact',
      title: `${fact.subject} ${fact.predicate}${fact.topic ? ` ${fact.topic}` : ''}`,
      text: fact.value && fact.value !== fact.object ? `${fact.object}\n${fact.value}`.trim() : (fact.value || fact.object),
      projectId: fact.projectId,
      projectName: fact.projectName,
      status: fact.status,
      factStatus: fact.status,
      confidence: fact.confidence,
      assertionType: fact.assertionType || 'system',
      evidenceLevel: fact.evidenceLevel || 'unverified',
      validFrom: fact.validFrom,
      validTo: fact.validTo,
      contradictionGroup: fact.contradictionGroup,
      importance: 3,
      tags: fact.tags,
      updatedAt: fact.observedAt || fact.recordedAt,
      source: fact.source,
      candidateOrigin: input.candidateIds ? 'local-index' : 'canonical-scan',
      indexMatch: input.indexMatches?.[fact.id] || null,
    }));
  }

  function invalidateFact(state, input = {}) {
    const fact = state.facts.find((item) => item.id === safeId(input.id));
    if (!fact) throw new Error('fact bulunamadi');
    fact.status = 'invalidated';
    fact.validTo = safeIso(input.validTo, nowIso());
    fact.invalidatedAt = nowIso();
    if (input.reason) fact.invalidateReason = safeText(redact(input.reason).text, 240);
    return fact;
  }

  function disputeFact(state, input = {}) {
    const fact = state.facts.find((item) => item.id === safeId(input.id));
    if (!fact) throw new Error('fact bulunamadi');
    const mates = state.facts.filter((item) => item.id !== fact.id && item.slot === fact.slot
      && ['active', 'disputed'].includes(item.status));
    const group = fact.contradictionGroup || mates.map((item) => item.contradictionGroup).find(Boolean) || randomId('cg');
    fact.status = 'disputed';
    fact.contradictionGroup = group;
    for (const item of mates) item.contradictionGroup = item.contradictionGroup || group;
    if (input.reason) fact.disputeReason = safeText(redact(input.reason).text, 240);
    return fact;
  }

  function forgetFact(state, input = {}) {
    const id = safeId(input.id);
    const index = state.facts.findIndex((item) => item.id === id);
    if (index === -1) return null;
    const mode = input.mode === 'hard' || input.hard === true ? 'hard' : 'soft';
    let relationsCleaned = 0;
    const relationChangedIds = [];
    if (mode === 'hard') {
      state.facts.splice(index, 1);
      for (const other of state.facts) {
        const beforePrevious = (other.supersedes || []).length;
        const beforeNext = (other.supersededBy || []).length;
        other.supersedes = (other.supersedes || []).filter((factId) => factId !== id);
        other.supersededBy = (other.supersededBy || []).filter((factId) => factId !== id);
        const cleaned = beforePrevious - other.supersedes.length + beforeNext - other.supersededBy.length;
        relationsCleaned += cleaned;
        if (cleaned) relationChangedIds.push(other.id);
      }
    } else {
      const fact = state.facts[index];
      fact.status = 'forgotten';
      fact.forgottenAt = nowIso();
      fact.forgetReason = safeText(redact(input.reason).text, 240);
      // Kronoloji ve iliski kimlikleri kalir; aranabilir/okunabilir tum ozgun
      // metin ve kaynak yollarinin yerine anonim tombstone gecer.
      fact.subject = '[UNUTULDU]';
      fact.object = '[UNUTULDU]';
      fact.value = '[UNUTULDU]';
      fact.topic = '[UNUTULDU]';
      fact.tags = [];
      fact.projectName = '[UNUTULDU]';
      fact.workspace = '';
      fact.slot = `forgotten|${fact.id}`;
      fact.tombstone = true;
      fact.source = {
        ...(fact.source || {}),
        noteId: fact.source?.noteId ? '[UNUTULDU]' : '',
        file: fact.source?.file ? '[UNUTULDU]' : '',
      };
      delete fact.migrationKey;
      delete fact.invalidateReason;
      delete fact.disputeReason;
      delete fact.conflictSuggestions;
    }
    return {
      ok: true, id, mode, hard: mode === 'hard', fact: true,
      factsForgotten: mode === 'soft' ? 1 : 0,
      factsRemoved: mode === 'hard' ? 1 : 0,
      relationsCleaned,
      changedIds: mode === 'soft' ? [id] : relationChangedIds,
      removedIds: mode === 'hard' ? [id] : [],
    };
  }

  function forgetFactsBySource(state, { sessionId, memoryId, mode = 'soft' } = {}) {
    const result = { factsForgotten: 0, factsRemoved: 0, relationsCleaned: 0, changedIds: [], removedIds: [] };
    if (sessionId) {
      const ids = state.facts.filter((fact) => fact.source?.sessionId === sessionId).map((fact) => fact.id);
      for (const factId of ids) {
        const forgotten = forgetFact(state, { id: factId, mode });
        if (!forgotten) continue;
        result.factsForgotten += forgotten.factsForgotten;
        result.factsRemoved += forgotten.factsRemoved;
        result.relationsCleaned += forgotten.relationsCleaned;
        result.changedIds.push(...forgotten.changedIds);
        result.removedIds.push(...forgotten.removedIds);
      }
    }
    if (memoryId) {
      const ids = state.facts.filter((fact) => fact.migrationKey === memoryId && fact.status !== 'forgotten').map((fact) => fact.id);
      for (const factId of ids) {
        const forgotten = forgetFact(state, { id: factId, mode, reason: 'kaynak hafiza unutuldu' });
        if (!forgotten) continue;
        result.factsForgotten += forgotten.factsForgotten;
        result.factsRemoved += forgotten.factsRemoved;
        result.relationsCleaned += forgotten.relationsCleaned;
        result.changedIds.push(...forgotten.changedIds);
        result.removedIds.push(...forgotten.removedIds);
      }
    }
    result.changedIds = [...new Set(result.changedIds)];
    result.removedIds = [...new Set(result.removedIds)];
    return result;
  }

  function timeline(state, input = {}) {
    const versions = selectFacts(state, { ...input, includeHistorical: true, includeForgotten: true, status: input.status || '', limit: 500 })
      .sort((a, b) => Date.parse(a.validFrom || a.recordedAt || 0) - Date.parse(b.validFrom || b.recordedAt || 0));
    const slots = new Map();
    for (const fact of versions) {
      if (!slots.has(fact.slot)) slots.set(fact.slot, []);
      slots.get(fact.slot).push({
        id: fact.id, subject: fact.subject, predicate: fact.predicate, topic: fact.topic,
        object: fact.object, value: fact.value, status: fact.status, confidence: fact.confidence,
        validFrom: fact.validFrom, validTo: fact.validTo, recordedAt: fact.recordedAt,
        supersedes: fact.supersedes, supersededBy: fact.supersededBy,
        contradictionGroup: fact.contradictionGroup, source: fact.source,
        projectId: fact.projectId, projectName: fact.projectName,
      });
    }
    return {
      subject: safeText(input.subject, 200),
      predicate: safeText(input.predicate, 80),
      slots: [...slots.entries()].map(([slot, items]) => ({
        slot,
        current: [...items].reverse().find((item) => item.status === 'active') || null,
        versions: items,
      })),
      total: versions.length,
    };
  }

  function factSummary(fact) {
    if (!fact) return null;
    if (fact.status === 'forgotten') return {
      id: fact.id, subject: '[UNUTULDU]', predicate: fact.predicate, object: '[UNUTULDU]',
      value: '[UNUTULDU]', status: 'forgotten', confidence: fact.confidence,
      validFrom: fact.validFrom, validTo: fact.validTo, tombstone: true,
    };
    return {
      id: fact.id, subject: fact.subject, predicate: fact.predicate, object: fact.object,
      value: fact.value, topic: fact.topic, status: fact.status, confidence: fact.confidence,
      projectId: fact.projectId || null, projectName: fact.projectName || null,
      assertionType: fact.assertionType, evidenceLevel: fact.evidenceLevel,
      validFrom: fact.validFrom, validTo: fact.validTo,
    };
  }

  function provenance(state, id, readEvents) {
    const fact = state.facts.find((item) => item.id === safeId(id));
    if (!fact) throw new Error('fact bulunamadi');
    const forgotten = fact.status === 'forgotten';
    const session = fact.source?.sessionId ? state.sessions.find((item) => item.id === fact.source.sessionId) || null : null;
    const checkpoint = fact.source?.checkpointId ? state.checkpoints.find((item) => item.id === fact.source.checkpointId) || null : null;
    let event = null;
    if (fact.source?.eventId && fact.source?.sessionId && typeof readEvents === 'function') {
      event = readEvents(fact.source.sessionId, 1000).find((item) => item.id === fact.source.eventId) || null;
    }
    const resolve = (ids) => (ids || []).map((factId) => factSummary(state.facts.find((item) => item.id === factId))).filter(Boolean);
    const chainParts = [];
    if (fact.source?.agent) chainParts.push(`${fact.source.agent} ajani`);
    if (session) chainParts.push(`"${session.title}" oturumu`);
    else if (fact.source?.sessionId) chainParts.push(`${fact.source.sessionId} oturumu`);
    if (checkpoint) chainParts.push(`"${checkpoint.title}" checkpointi`);
    if (event) chainParts.push(`${event.type} olayi`);
    if (fact.source?.noteId) chainParts.push(`"${fact.source.noteId}" notu`);
    if (fact.source?.file) chainParts.push(`${fact.source.file} dosyasi`);
    if (fact.migrationKey) chainParts.push('eski hafiza kaydindan migrationla');
    const evidenceChain = [];
    const addEvidence = (type, sourceId, resolved, details = {}) => {
      if (!sourceId) return;
      evidenceChain.push({ type, id: sourceId, resolved: !!resolved, ...details });
    };
    addEvidence('session', fact.source?.sessionId, session, session && !forgotten ? { title: session.title, agent: session.agent } : {});
    addEvidence('checkpoint', fact.source?.checkpointId, checkpoint, checkpoint && !forgotten ? { title: checkpoint.title, sessionId: checkpoint.sessionId } : {});
    addEvidence('event', fact.source?.eventId, event, event ? { eventType: event.type, sessionId: event.sessionId } : {});
    addEvidence('note', fact.source?.noteId, true);
    addEvidence('file', fact.source?.file, true);
    if (fact.migrationKey) addEvidence('migration', fact.migrationKey, true);
    const evidenceLabel = fact.evidenceLevel === 'direct' ? 'dogrudan kanitli'
      : fact.evidenceLevel === 'derived' ? 'turetilmis kanitli'
        : 'dogrulanmamis';
    return {
      fact: { ...fact },
      source: {
        agent: fact.source?.agent || '',
        client: fact.source?.client || '',
        session: session ? (forgotten
          ? { id: session.id, status: session.status }
          : { id: session.id, title: session.title, agent: session.agent, status: session.status, startedAt: session.startedAt }) : null,
        checkpoint: checkpoint ? (forgotten
          ? { id: checkpoint.id, sessionId: checkpoint.sessionId }
          : { id: checkpoint.id, title: checkpoint.title, summary: checkpoint.summary, createdAt: checkpoint.createdAt, sessionId: checkpoint.sessionId }) : null,
        event: event ? (forgotten
          ? { id: event.id, type: event.type, createdAt: event.createdAt }
          : { id: event.id, type: event.type, content: event.content, createdAt: event.createdAt }) : null,
        noteId: fact.source?.noteId || '',
        file: fact.source?.file || '',
        migrationKey: fact.migrationKey || '',
      },
      history: {
        previous: resolve(fact.supersedes),
        next: resolve(fact.supersededBy),
      },
      assertionType: fact.assertionType || 'system',
      evidenceLevel: fact.evidenceLevel || 'unverified',
      evidenceChain,
      explanation: forgotten
        ? 'Bu kayit kullanici istegiyle unutuldu; yalniz anonim zaman ve iliski zinciri korunuyor.'
        : chainParts.length
        ? `Bu bilgi ${evidenceLabel}; ${chainParts.join(' → ')} kaynagindan geldi.`
        : fact.assertionType === 'user'
          ? 'Bu bilgi kullanici tarafindan dogrudan yazildi.'
          : 'Bu bilgi dogrulanabilir kaynak olmadan yazildi ve kesin gercek sayilmaz.',
    };
  }

  // Eski yapilandirilmis hafizalari fact'e cevirir. Her hafiza id'si
  // migrationKey olarak saklanir; ikinci calisma ayni kaydi atlar (idempotent).
  function migrateMemories(state) {
    const existing = new Set(state.facts.map((fact) => fact.migrationKey).filter(Boolean));
    const items = state.memories
      .filter((memory) => memory.status !== 'forgotten')
      .sort((a, b) => Date.parse(a.updatedAt || a.createdAt || 0) - Date.parse(b.updatedAt || b.createdAt || 0));
    let migrated = 0;
    for (const memory of items) {
      if (existing.has(memory.id) || memory.factId) continue;
      const base = {
        migrationKey: memory.id,
        scope: memory.projectId ? 'project' : 'global',
        projectId: memory.projectId || '',
        project: memory.projectName || '',
        confidence: clamp(0.55 + clamp(memory.importance, 1, 5, 3) * 0.05 + (memory.pinned ? 0.05 : 0), 0, 0.95, 0.7),
        observedAt: memory.updatedAt || memory.createdAt,
        validFrom: memory.createdAt || memory.updatedAt,
        tags: memory.tags,
        assertionType: 'imported',
        evidenceLevel: 'derived',
        noteId: `memory:${memory.id}`,
      };
      const byKind = memory.kind === 'preference'
        ? { subject: 'kullanici', predicate: 'tercih-eder', topic: memory.key, object: memory.content }
        : memory.kind === 'decision'
          ? { subject: memory.projectName || 'proje', predicate: 'karar-verdi', object: memory.content }
          : memory.kind === 'task'
            ? { subject: memory.key || memory.content, predicate: 'durum', object: memory.status === 'done' ? 'tamamlandi' : 'acik', value: memory.content }
            : { subject: memory.key || memory.content, predicate: 'sahip', object: memory.content };
      try {
        const result = upsertFact(state, { ...base, ...byKind }, memory.source || {}, memory.projectId
          ? { id: memory.projectId, name: memory.projectName, workspace: '' }
          : null);
        memory.factId = result.fact.id; // hafiza kaydina damga: ikinci calisma atlar
        migrated++;
      } catch { /* bos/uygunsuz eski kayit migrationu durdurmasin */ }
    }
    return { migrated, totalFacts: state.facts.length };
  }

  // Checkpoint icerigini fact'lere cevirir: kararlar, acik gorevler,
  // tamamlananlar ve riskler. Tekrarlanan (rolling) checkpointlerde ayni deger
  // tazeleme sayilir, kopya uretmez.
  function factsFromCheckpoint(state, checkpoint, session) {
    const project = { id: session.projectId, name: session.projectName, workspace: session.workspace };
    const source = { agent: session.agent, client: session.client, sessionId: session.id, checkpointId: checkpoint.id };
    const affectedIds = [];
    const write = (input) => {
      try {
        const result = upsertFact(state, { ...input, assertionType: 'agent', evidenceLevel: 'derived' }, source, project);
        affectedIds.push(...(result.affectedIds || [result.fact.id]));
      } catch { /* tek kalem hata checkpointi bozmasin */ }
    };
    for (const decision of checkpoint.decisions || []) {
      write({ subject: session.projectName || 'proje', predicate: 'karar-verdi', object: decision, confidence: 0.85 });
    }
    for (const task of checkpoint.openTasks || []) {
      write({ subject: task, predicate: 'durum', object: 'acik', value: task, confidence: 0.8 });
    }
    for (const done of checkpoint.completed || []) {
      write({ subject: done, predicate: 'durum', object: 'tamamlandi', value: done, confidence: 0.85 });
    }
    for (const risk of checkpoint.risks || []) {
      write({ subject: session.projectName || 'proje', predicate: 'risk', object: risk, confidence: 0.7 });
    }
    return [...new Set(affectedIds)];
  }

  function pruneFacts(state) {
    if (!Array.isArray(state.facts) || state.facts.length <= MAX_FACTS) return { removedIds: [], changedIds: [] };
    const keep = state.facts.filter((fact) => ['active', 'disputed'].includes(fact.status));
    const rest = state.facts.filter((fact) => !['active', 'disputed'].includes(fact.status))
      .sort((a, b) => Date.parse(b.recordedAt || 0) - Date.parse(a.recordedAt || 0))
      .slice(0, Math.max(0, MAX_FACTS - keep.length));
    const keptIds = new Set([...keep, ...rest].map((fact) => fact.id));
    const removedIds = state.facts.filter((fact) => !keptIds.has(fact.id)).map((fact) => fact.id);
    const removed = new Set(removedIds);
    const changedIds = [];
    for (const fact of [...keep, ...rest]) {
      const previous = (fact.supersedes || []).length + (fact.supersededBy || []).length;
      fact.supersedes = (fact.supersedes || []).filter((id) => !removed.has(id));
      fact.supersededBy = (fact.supersededBy || []).filter((id) => !removed.has(id));
      if (previous !== fact.supersedes.length + fact.supersededBy.length) changedIds.push(fact.id);
    }
    state.facts = [...keep, ...rest];
    return { removedIds, changedIds };
  }

  return {
    upsertFact,
    selectFacts,
    factCandidates,
    invalidateFact,
    disputeFact,
    suggestFactConflicts,
    resolveFactConflict,
    forgetFact,
    forgetFactsBySource,
    timeline,
    provenance,
    migrateMemories,
    factsFromCheckpoint,
    pruneFacts,
    validAt,
    factSlot,
  };
}

module.exports = {
  createTemporal, FACT_STATUSES, ASSERTION_TYPES, EVIDENCE_LEVELS,
  SINGLE_VALUED_PREDICATES, MAX_FACTS,
};
