import { escapeAttribute, escapeHtml } from './format';
import type { AgentQuestionField, AgentTranscriptEntry } from './host-types';
import { icon } from './icons';

/**
 * A question the launched agent asks in a form (ACP elicitation, form mode only; ADR-0030): its
 * card in the conversation, and the person's answer read from it. The host checks the answer
 * against the form again before the agent gets it; this reads the controls and says what is
 * missing on the card, so a refusal is seen where it was typed.
 */

/** What a control holds as the person left it: text for a box or a list, yes or no, the ticked choices. */
export type QuestionRaw = Record<string, string | boolean | string[]>;

const inputTypes: Record<string, string> = { email: 'email', uri: 'url', date: 'date' };

function control(entryId: string, field: AgentQuestionField): string {
  const id = `q-${entryId}-${field.name}`;
  const name = escapeAttribute(field.name);
  const required = field.required ? ' required' : '';
  switch (field.type) {
    case 'text':
      return `<input id="${escapeAttribute(id)}" data-question-field="${name}" type="${inputTypes[field.format ?? ''] ?? 'text'}"${field.maxLength === null ? '' : ` maxlength="${field.maxLength}"`}${field.default === null ? '' : ` value="${escapeAttribute(field.default)}"`}${required} autocomplete="off">`;
    case 'number':
    case 'integer':
      return `<input id="${escapeAttribute(id)}" data-question-field="${name}" type="number" step="${field.type === 'integer' ? '1' : 'any'}"${field.minimum === null ? '' : ` min="${field.minimum}"`}${field.maximum === null ? '' : ` max="${field.maximum}"`}${field.default === null ? '' : ` value="${escapeAttribute(field.default)}"`}${required}>`;
    case 'boolean':
      return `<input id="${escapeAttribute(id)}" data-question-field="${name}" type="checkbox"${field.default === 'true' ? ' checked' : ''}>`;
    case 'choice':
      return `<select id="${escapeAttribute(id)}" data-question-field="${name}"${required}>${field.required && field.default !== null ? '' : '<option value="">—</option>'}${(field.choices ?? []).map((choice) =>
        `<option value="${escapeAttribute(choice.value)}"${choice.value === field.default ? ' selected' : ''}>${escapeHtml(choice.title)}</option>`).join('')}</select>`;
    case 'choices':
      return `<span class="chat-question-choices" id="${escapeAttribute(id)}" role="group">${(field.choices ?? []).map((choice) =>
        `<label><input type="checkbox" data-question-field="${name}" value="${escapeAttribute(choice.value)}"> ${escapeHtml(choice.title)}</label>`).join('')}</span>`;
    default:
      return '<span class="chat-question-unsupported">Nendo cannot show this field.</span>';
  }
}

/**
 * The card: the agent's words, each field with its own label, Submit and Decline; once answered,
 * what was sent. A form with a field Nendo cannot show offers Decline only.
 */
export function questionMarkup(entry: AgentTranscriptEntry, agentName: string, key: string): string {
  const fields = entry.fields ?? [];
  const head = `<div class="chat-question-head">${icon('help')}<strong>${escapeHtml(`${agentName} asks${entry.title === null ? '' : `: ${entry.title}`}`)}</strong></div>${entry.text === '' ? '' : `<p class="chat-plain">${escapeHtml(entry.text)}</p>`}`;
  if (entry.status !== 'waiting')
    return `<section class="chat-question is-done" data-item="${key}">${head}<p class="chat-question-answer">${escapeHtml(entry.answer ?? entry.status ?? '')}</p></section>`;
  const showable = fields.every((field) => field.type !== 'unsupported');
  const rows = fields.map((field) => `<div class="chat-question-row" data-type="${escapeAttribute(field.type)}"><label for="${escapeAttribute(`q-${entry.id}-${field.name}`)}">${escapeHtml(field.title)}${field.required ? ' <span aria-hidden="true">*</span>' : ''}</label>${control(entry.id, field)}${field.description === null ? '' : `<small>${escapeHtml(field.description)}</small>`}</div>`).join('');
  return `<form class="chat-question" data-item="${key}" data-question="${escapeAttribute(entry.id)}" novalidate>${head}${rows}
    <p class="chat-question-note">${showable ? 'Never type a password or a key here: the answer goes to the agent as it is.' : 'This question has a field Nendo cannot show. Decline it, or answer the agent in a message.'}</p>
    <p class="chat-question-error" role="alert" hidden></p>
    <div class="chat-question-actions">${showable ? '<button type="submit" class="primary-button">Send answer</button>' : ''}<button type="button" class="secondary-button" data-question-decline="${escapeAttribute(entry.id)}">Decline</button></div>
  </form>`;
}

/**
 * The answer as the agent takes it, from what the controls hold: text as text, numbers as
 * numbers, yes or no, the ticked choices. An empty optional field is left out; the first missing
 * or malformed one is named.
 */
export function questionAnswer(fields: readonly AgentQuestionField[], raw: QuestionRaw): { content: Record<string, unknown> } | { error: string } {
  const content: Record<string, unknown> = {};
  for (const field of fields) {
    const value = raw[field.name];
    switch (field.type) {
      case 'boolean':
        content[field.name] = value === true;
        break;
      case 'choices':
        if (Array.isArray(value) && value.length > 0) content[field.name] = value;
        else if (field.required) return { error: `${field.title} needs an answer.` };
        break;
      case 'number':
      case 'integer': {
        const text = typeof value === 'string' ? value.trim() : '';
        if (text === '') { if (field.required) return { error: `${field.title} needs an answer.` }; break; }
        const number = Number(text);
        if (!Number.isFinite(number) || (field.type === 'integer' && !Number.isInteger(number))) return { error: `${field.title} is ${field.type === 'integer' ? 'a whole number' : 'a number'}.` };
        content[field.name] = number;
        break;
      }
      default: {
        const text = typeof value === 'string' ? value : '';
        if (text === '') { if (field.required) return { error: `${field.title} needs an answer.` }; break; }
        content[field.name] = text;
      }
    }
  }
  return { content };
}
