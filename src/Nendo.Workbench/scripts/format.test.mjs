import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'vite';
const bundle = await build({configFile:false,logLevel:'error',build:{ssr:'src/format.ts',write:false,rollupOptions:{output:{codeSplitting:false}}}});
const {proposalAuthorLine,activityLabel,agentModeLabel,canCompensate,capitalise,choiceDisplay,cssToken,escapeAttribute,escapeHtml,fieldName,isAgentAccessMode,isProposalPreviewable,laneLabel,messageFor,mutationKey,operationLabel,presentationLabel,proposalStateLabel,reversibilityLabel,reviewKindLabel,sameValue,shortId,stringValue,storageLabel,valueDisplay} = await import('data:text/javascript;base64,'+Buffer.from(bundle.output.find(item=>item.type==='chunk').code).toString('base64'));

const plan={entity:{fields:[{semanticId:'name',displayName:'Name'}],derivedFields:[{semanticId:'total',displayName:'Total'}]}};
const revision=(revisionId,canRequestCompensation=true)=>({revisionId,canRequestCompensation,compensationOfRevisionId:null});

test('a value is shown exactly as stored, and an exact number never goes through a float',()=>{
 assert.equal(stringValue({$nendoNumber:'10.50'}),'10.50');
 assert.equal(stringValue(null),'');
 assert.equal(stringValue(undefined),'');
 assert.equal(stringValue('text'),'text');
 // A boolean reads as a word on screen but as itself in a payload.
 assert.equal(valueDisplay(true),'Yes');
 assert.equal(valueDisplay(false),'No');
 assert.equal(valueDisplay(null),'');
});

test('two values are the same when an unset one and a missing one agree',()=>{
 assert.equal(sameValue(null,undefined),true);
 assert.equal(sameValue('a','a'),true);
 assert.equal(sameValue(1,'1'),false);
 assert.equal(sameValue({a:1},{a:1}),true);
});

test('a field is named by the entity, then by a calculation, then by its own id',()=>{
 assert.equal(fieldName(plan,'name'),'Name');
 assert.equal(fieldName(plan,'total'),'Total');
 // An id with no definition still has to print something a person can report.
 assert.equal(fieldName(plan,'missing'),'missing');
});

test('a retired choice says so, and an unknown stored value prints itself',()=>{
 const field={choices:[{id:'open',displayName:'Open',retired:false},{id:'old',displayName:'Old',retired:true}]};
 assert.equal(choiceDisplay(field,'open'),'Open');
 assert.equal(choiceDisplay(field,'old'),'Old (retired)');
 assert.equal(choiceDisplay(field,'gone'),'gone');
 assert.equal(choiceDisplay({},'gone'),'gone');
});

test('the host may send a storage kind as a number or a name, and both read the same',()=>{
 assert.equal(storageLabel(0),'Text');
 assert.equal(storageLabel(7),'Reference');
 assert.equal(storageLabel('reference'),'Reference');
 // An unsupported kind names what it was, so the owner can ask for it.
 assert.equal(storageLabel(8),'Unsupported');
 assert.equal(storageLabel(8,'geo'),'Unsupported: geo');
 assert.equal(storageLabel('unsupported','geo'),'Unsupported: geo');
});

test('a camelCase presentation kind is read out in words',()=>{
 assert.equal(presentationLabel('singleLine'),'Single line');
 assert.equal(presentationLabel('dateTime'),'Date and time');
 assert.equal(presentationLabel(null),'Stored value');
 // A kind this build does not know still reads as words rather than an identifier.
 assert.equal(presentationLabel('richText'),'Rich text');
});

test('the four agent access modes are the closed set, and nothing else is one',()=>{
 assert.equal(isAgentAccessMode('shapeApp'),true);
 assert.equal(isAgentAccessMode('ShapeApp'),false);
 assert.equal(isAgentAccessMode('admin'),false);
 assert.equal(agentModeLabel('editData'),'Edit data');
 assert.equal(agentModeLabel('off'),'Off');
});

test('a lane and a reversibility class read the same whether sent as a number or a name',()=>{
 assert.equal(laneLabel(0),'Genesis');
 assert.equal(laneLabel(2),'Data');
 assert.equal(laneLabel('definition'),'Definition');
 assert.equal(reversibilityLabel(0),'Reversible');
 assert.equal(reversibilityLabel('reversibleWithRetainedState'),'Compensatable with retained state');
 assert.equal(reversibilityLabel('irreversibleDeclared'),'Not compensatable');
 // An unrecognised class is never claimed to be reversible.
 assert.equal(reversibilityLabel('somethingNew'),'Not compensatable');
});

test('a revision stops offering compensation once some later revision compensates it',()=>{
 const target=revision('r1');
 assert.equal(canCompensate(target,[target]),true);
 assert.equal(canCompensate(target,[target,{revisionId:'r2',canRequestCompensation:true,compensationOfRevisionId:'r1'}]),false);
 // The host's own refusal outranks the history.
 assert.equal(canCompensate(revision('r3',false),[]),false);
});

test('only a previewable proposal can be accepted, and the label says which state it is in',()=>{
 assert.equal(isProposalPreviewable(3),true);
 assert.equal(isProposalPreviewable('previewable'),true);
 assert.equal(isProposalPreviewable('Previewable'),true);
 assert.equal(isProposalPreviewable(6),false);
 assert.equal(proposalStateLabel(3),'Ready to review');
 assert.equal(proposalStateLabel(6),'Needs a new preview');
 assert.equal(proposalStateLabel('stale'),'Needs a new preview');
 assert.equal(proposalStateLabel(1),'Cannot apply');
});

test('agent activity is named by what the person would say happened, not by the tool id',()=>{
 assert.equal(activityLabel({category:'session',name:'connected'}),'Agent connected');
 assert.equal(activityLabel({category:'session',name:'disconnected'}),'Agent disconnected');
 assert.equal(activityLabel({category:'resource',name:'nendo://x/records'}),'Read records');
 assert.equal(activityLabel({category:'resource',name:'nendo://x/unknown'}),'Read workspace details');
 assert.equal(activityLabel({category:'mutation',name:'nendo.data.set_field'}),'Edited a record');
 // An unnamed mutation still reports that data changed rather than going silent.
 assert.equal(activityLabel({category:'mutation',name:'nendo.data.something_new'}),'Changed workspace data');
});

test('a surface kind is reviewed under its screen name, and an unknown kind prints itself',()=>{
 assert.equal(reviewKindLabel('boardSurface'),'Board');
 assert.equal(reviewKindLabel('detailSurface'),'Record page');
 assert.equal(reviewKindLabel('somethingNew'),'somethingNew');
 assert.equal(operationLabel('data.setField'),'Set field');
 assert.equal(operationLabel('behaviour.somethingNew'),'behaviour.somethingNew');
});

test('markup escaping closes every attribute and element route out of a value',()=>{
 assert.equal(escapeHtml('<b>&"x</b>'),'&lt;b&gt;&amp;&quot;x&lt;/b&gt;');
 assert.equal(escapeHtml("it's"),'it&#039;s');
 // Attributes are quoted the same way, so one escape covers both positions.
 assert.equal(escapeAttribute('a" onclick="x'),'a&quot; onclick=&quot;x');
 assert.equal(cssToken('Close date'),'close-date');
 assert.equal(cssToken('a/b c'),'a-b-c');
 assert.equal(capitalise('board'),'Board');
 assert.equal(capitalise(''),'');
});

test('a long identifier is shortened for the screen but never cut short of the limit',()=>{
 assert.equal(shortId('short-id'),'short-id');
 assert.equal(shortId('0123456789012345678'),'012345678901234…');
 assert.equal(shortId('012345678901234567'),'012345678901234567');
});

test('a host failure reports its own message, and anything else gets one a person can act on',()=>{
 assert.equal(messageFor(new Error('Refused: the field is required.')),'Refused: the field is required.');
 assert.equal(messageFor('a bare string'),'The Workbench could not complete the request.');
 assert.equal(messageFor(null),'The Workbench could not complete the request.');
});

test('every mutation carries a distinct idempotency key',()=>{
 const first=mutationKey();
 assert.match(first,/^studio-[0-9a-f-]{36}$/);
 assert.notEqual(first,mutationKey());
});

test('a proposal a custom view prepared says which package is asking; any other keeps the plain sentence',()=>{
 const packages=[{packageId:'org.example.glance',title:'Glance'}];
 assert.equal(proposalAuthorLine({origin:'extension:org.example.glance'},packages),'Prepared by the custom view Glance (org.example.glance). Nothing changes until you accept.');
 assert.equal(proposalAuthorLine({origin:'extension:org.example.gone'},packages),'Prepared by the custom view org.example.gone. Nothing changes until you accept.');
 assert.equal(proposalAuthorLine({origin:'workbench'},packages),'Your active file is unchanged until you accept.');
 assert.equal(proposalAuthorLine({},packages),'Your active file is unchanged until you accept.');
});
