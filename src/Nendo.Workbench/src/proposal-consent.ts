import { escapeHtml } from './format';
import type { ProposalBehaviour } from './host-types';
import { icon } from './icons';

// What accepting a proposal means for this device's consent to the file's automatic
// actions, said in the review and in the queue before anyone presses Accept (ADR-0009,
// 2026-09-29 amendment; W-008). The approval panel used to be the first place this
// appeared, and it appeared after acceptance, with editing already paused.
//
// The preview carries facts; whether consent is held right now is read from the
// session, because a preview kept in the queue cannot know about a later approval or
// a withdrawal.

export interface ConsentTrust {
  requiresApproval: boolean;
  isApproved: boolean;
}

export type ProposalConsentKind = 'approved' | 'approve-first' | 'approve-after' | 'split';

export interface ProposalConsent {
  kind: ProposalConsentKind;
  /** The sentence the review shows, as plain text. */
  sentence: string;
  /** The words the queue adds after a proposal's size, or null when it needs none. */
  queueNote: string | null;
  /** Accepting would be refused as things stand, so the review does not offer it. */
  blocksAcceptance: boolean;
}

export function proposalConsent(
  behaviour: ProposalBehaviour | null | undefined,
  trust: ConsentTrust | null | undefined,
): ProposalConsent | null {
  if (!behaviour) return null;
  const effects = effectsOf(behaviour);
  const changes = pluralChanges(behaviour.generatedEffectCount);
  if (behaviour.changesWhatIsApproved && behaviour.generatedEffectCount > 0) {
    return {
      kind: 'split',
      sentence: `This proposal changes the file’s automatic actions and also sets them off: ${changes} they make are part of it. Approval can only be given to actions the file already holds, so accepting this would be refused. Reject it and ask for the actions first and the records after.`,
      queueNote: 'cannot be accepted as it stands',
      blocksAcceptance: true,
    };
  }
  if (behaviour.changesWhatIsApproved) {
    return {
      kind: 'approve-after',
      sentence: `After you accept, this file’s automatic actions can ${effects} on their own. Editing pauses until you approve them on the Agent page; your data stays readable.`,
      queueNote: 'automatic actions to approve after accepting',
      blocksAcceptance: false,
    };
  }
  if (trust?.isApproved === true) {
    return {
      kind: 'approved',
      sentence: `Accepting runs this file’s automatic actions: ${changes} they make are part of it. You approved them on this device.`,
      queueNote: null,
      blocksAcceptance: false,
    };
  }
  return {
    kind: 'approve-first',
    sentence: `Accepting runs this file’s automatic actions, which can ${effects} and are not approved on this device: ${changes} they make are part of it. Approve them on the Agent page first.`,
    queueNote: 'approve automatic actions first',
    blocksAcceptance: true,
  };
}

export function proposalConsentMarkup(consent: ProposalConsent | null): string {
  if (consent === null) return '';
  const tinted = consent.kind === 'approved' ? '' : ' is-tinted';
  return `<div class="proposal-consent callout${tinted}" data-testid="proposal-consent" data-consent="${consent.kind}">
    <span class="callout-icon">${icon(consent.kind === 'approved' ? 'command' : 'alert')}</span>
    <h4>Automatic actions</h4>
    <p>${escapeHtml(consent.sentence)}</p>
  </div>`;
}

function effectsOf(behaviour: ProposalBehaviour): string {
  const effects = [
    behaviour.createsRecords ? 'add records' : null,
    behaviour.updatesRecords ? 'change records' : null,
    behaviour.deletesRecords ? 'delete records' : null,
  ].filter((effect): effect is string => effect !== null);
  if (effects.length === 0) return 'write';
  if (effects.length === 1) return effects[0];
  return `${effects.slice(0, -1).join(', ')} and ${effects[effects.length - 1]}`;
}

function pluralChanges(count: number): string {
  return count === 1 ? 'the 1 change' : `the ${count} changes`;
}
