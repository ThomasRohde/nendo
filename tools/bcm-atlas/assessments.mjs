// Dated assessments for the Capability Atlas (W-080), derived from capabilities as they stand.
//
// migrated()      what the file already knows, moved without loss: each capability's current
//                 maturity becomes one Maturity assessment, dated when it was last reviewed, with
//                 its evidence and its owner as the assessor. The target stays on the capability,
//                 where it is a goal rather than a judgement.
// demonstration() fictional history for the Northstar demo, so the map has something to compare:
//                 an earlier Maturity baseline, and IT health and Business value for each
//                 capability. Every one says it is fictional.
//
// northstar.mjs puts both into the shipped model; Upgrade-BcmAssessments.mjs sends them to a live
// BCM.nendo from the records it reads there.

/** The day a capability with no review date is taken to have been assessed on. */
export const BASELINE_REVIEW = '2026-09-15';
/** The fictional earlier assessment the Northstar demo compares against. */
export const BASELINE_DATE = '2026-03-15';

const assessment = (capability, dimension, score, date, assessor, evidence, suffix) => ({
  recordId: `${capability.recordId}.assess.${suffix}`,
  values: {
    'assess.name': `${capability.values['cap.code'] ?? capability.recordId} · ${dimension} · ${date}`,
    'assess.capability': capability.recordId,
    'assess.dimension': dimension,
    'assess.score': score,
    'assess.date': date,
    'assess.assessor': assessor,
    'assess.evidence': evidence,
  },
});

/** Each capability's current maturity as its first Maturity assessment. Nothing is invented. */
export function migrated(capabilities) {
  return capabilities
    .filter(capability => capability.values['cap.maturity'] != null)
    .map(capability => assessment(capability, 'Maturity', Number(capability.values['cap.maturity']),
      capability.values['cap.reviewed'] ?? BASELINE_REVIEW, capability.values['cap.owner'] ?? null,
      capability.values['cap.evidence'] ?? null, 'maturity'));
}

/**
 * Each initiative's primary capability as its first scope link (W-081): what the file already
 * says, moved into the link type without loss. The primary capability stays on the initiative.
 */
export function scopedFromPrimary(initiatives) {
  return initiatives.filter(initiative => initiative.values['initiative.capability']).map(initiative => ({
    recordId: `${initiative.recordId}.scope.primary`,
    values: {
      'scope.name': `${initiative.values['initiative.code'] ?? initiative.recordId} · primary`,
      'scope.initiative': initiative.recordId,
      'scope.capability': initiative.values['initiative.capability'],
      'scope.note': 'Primary capability.',
    },
  }));
}

/** Fictional wider scope for the Northstar demo: each initiative also changes two of its capability's siblings. */
export function demonstrationScope(initiatives, capabilities) {
  const parentOf = new Map(capabilities.map(capability => [capability.recordId, capability.values['cap.parent']]));
  return initiatives.flatMap(initiative => {
    const primary = initiative.values['initiative.capability'];
    const siblings = capabilities.filter(capability => primary && capability.recordId !== primary &&
      capability.values['cap.parent'] === parentOf.get(primary)).slice(0, 2);
    return siblings.map((capability, index) => ({
      recordId: `${initiative.recordId}.scope.${index + 1}`,
      values: {
        'scope.name': `${initiative.values['initiative.code'] ?? initiative.recordId} · ${capability.values['cap.code'] ?? capability.recordId}`,
        'scope.initiative': initiative.recordId,
        'scope.capability': capability.recordId,
        'scope.note': 'Fictional wider scope for the demonstration model.',
      },
    }));
  });
}

/** Fictional history for the Northstar demo, derived from each capability's position. */
export function demonstration(capabilities) {
  const records = [];
  capabilities.forEach((capability, index) => {
    const maturity = capability.values['cap.maturity'];
    // One capability in three was a level lower in March; one in seven was a level higher.
    if (maturity != null) {
      const before = index % 3 === 0 ? Math.max(1, maturity - 1) : index % 7 === 0 ? Math.min(5, maturity + 1) : maturity;
      records.push(assessment(capability, 'Maturity', before, BASELINE_DATE, 'Northstar demo',
        'Fictional baseline assessment for the demonstration model.', 'baseline'));
    }
    const importance = capability.values['cap.importance'];
    const value = importance === 'Differentiating' ? 5 : importance === 'Core' ? 4 - (index % 2) : 2 + (index % 2);
    records.push(assessment(capability, 'Business value', value, BASELINE_REVIEW, 'Northstar demo',
      'Fictional business value assessment for the demonstration model.', 'value'));
    records.push(assessment(capability, 'IT health', 1 + ((index * 3 + 1) % 5), BASELINE_REVIEW, 'Northstar demo',
      'Fictional IT health assessment for the demonstration model.', 'health'));
  });
  return records;
}
