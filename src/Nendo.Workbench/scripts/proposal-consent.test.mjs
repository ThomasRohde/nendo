import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { build } from 'vite';

// W-008 (ADR-0009, 2026-09-29 amendment): the review and the queue say what accepting a
// proposal means for consent to the file's automatic actions, before Accept is pressed.
// Before this, the first word about it was after acceptance, with editing already paused,
// and a proposal the host would refuse to promote was offered with Accept enabled.
//
// Measured from the real functions the views draw with, and from the view sources for
// the one thing a bundle cannot reach: that both reviews disable Accept on the answer.
const bundleOf = async (entry) => {
  const bundle = await build({ configFile: false, logLevel: 'error', build: { ssr: entry, write: false, rollupOptions: { output: { codeSplitting: false } } } });
  return import('data:text/javascript;base64,' + Buffer.from(bundle.output.find(item => item.type === 'chunk').code).toString('base64'));
};
const { proposalConsent, proposalConsentMarkup } = await bundleOf('src/proposal-consent.ts');

const facts = (overrides) => ({ createsRecords: false, updatesRecords: true, deletesRecords: false, generatedEffectCount: 0, changesWhatIsApproved: false, ...overrides });
const approved = { requiresApproval: true, isApproved: true };
const notApproved = { requiresApproval: true, isApproved: false };

test('a proposal that asks nothing of consent shows nothing', () => {
  assert.equal(proposalConsent(null, approved), null);
  assert.equal(proposalConsent(undefined, notApproved), null);
  assert.equal(proposalConsentMarkup(null), '');
});

test('setting off actions this device approved is said, and Accept stays offered', () => {
  const consent = proposalConsent(facts({ generatedEffectCount: 2 }), approved);
  assert.equal(consent.kind, 'approved');
  assert.equal(consent.blocksAcceptance, false);
  assert.equal(consent.queueNote, null, 'the queue should not flag something already approved');
  assert.match(consent.sentence, /the 2 changes they make/);
});

test('setting off actions that are not approved here asks for approval first and withholds Accept', () => {
  const consent = proposalConsent(facts({ generatedEffectCount: 1, deletesRecords: true }), notApproved);
  assert.equal(consent.kind, 'approve-first');
  assert.equal(consent.blocksAcceptance, true, 'the host refuses this promotion, so the review must not offer it');
  assert.match(consent.sentence, /change records and delete records/);
  assert.match(consent.sentence, /Approve them on the Agent page first/);
  assert.equal(consent.queueNote, 'approve automatic actions first');
});

test('the approval is read from the session, not from the preview the queue kept', () => {
  const behaviour = facts({ generatedEffectCount: 1 });
  assert.equal(proposalConsent(behaviour, notApproved).kind, 'approve-first');
  assert.equal(proposalConsent(behaviour, approved).kind, 'approved');
});

test('a proposal after which consent must be given again says editing pauses, and still accepts', () => {
  const consent = proposalConsent(facts({ changesWhatIsApproved: true, createsRecords: true }), approved);
  assert.equal(consent.kind, 'approve-after');
  assert.equal(consent.blocksAcceptance, false);
  assert.match(consent.sentence, /Editing pauses until you approve them/);
  assert.equal(consent.queueNote, 'automatic actions to approve after accepting');
});

test('a proposal that both changes and sets off the actions is named as one nobody can accept', () => {
  const consent = proposalConsent(facts({ changesWhatIsApproved: true, generatedEffectCount: 3 }), approved);
  assert.equal(consent.kind, 'split');
  assert.equal(consent.blocksAcceptance, true);
  assert.match(consent.sentence, /ask for the actions first and the records after/);
});

test('the review markup carries the kind, the sentence and a tone the stylesheet knows', () => {
  const markup = proposalConsentMarkup(proposalConsent(facts({ generatedEffectCount: 1 }), notApproved));
  assert.match(markup, /data-consent="approve-first"/);
  assert.match(markup, /class="proposal-consent callout is-tinted"/);
  assert.match(markup, /Approve them on the Agent page first/);
  const styles = readFileSync(new URL('../src/styles/14-refinements-controls.css', import.meta.url), 'utf8');
  for (const name of ['.proposal-consent ', '.proposal-consent-note']) {
    assert.ok(styles.includes(name), `${name.trim()} is emitted and has no rule`);
  }
});

test('both reviews put the sentence first in the summary and disable Accept when accepting would be refused', () => {
  for (const [file, button] of [['view-agent.ts', 'accept-agent-proposal'], ['view-proposal.ts', 'accept-proposal']]) {
    const source = readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const line = source.split('\n').find((candidate) => candidate.includes(`id="${button}"`));
    assert.ok(line, `${file} has no ${button} button, so this guard reads the wrong markup`);
    assert.match(line, /consent\?\.blocksAcceptance === true/, `${file} offers Accept whatever the consent says`);
    // First in the summary panel: Accept is pinned to the panel's foot, and a sentence
    // placed after a long list of screens was measured off screen while Accept was withheld.
    assert.match(source, /<aside class="proposal-summary"><h3>[^<]+<\/h3>\$\{proposalConsentMarkup\(consent\)\}/,
      `${file} does not put the consent sentence first in the summary`);
  }
  const agent = readFileSync(new URL('../src/view-agent.ts', import.meta.url), 'utf8');
  assert.match(agent, /\$\{queueConsentNote\(pending\.behaviour\)\}/, 'the Pending changes queue does not name the consent step');
});
