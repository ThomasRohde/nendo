import { state } from './app-state';
import { escapeAttribute, escapeHtml } from './format';
import { type HelpSection, groupHelpTopics, helpSearchText, helpTopics } from './help';
import { content, requiredElement } from './shell';
/**
 * Help: how the system works, the guides, and the reference this build ties to
 * its own MCP surface. It owns two scroll regions, so the index stays put while
 * the article scrolls and the other way round.
 */

export function renderHelp(): void {
  const topics = helpTopics({ entities: state.session.entities,
    applications: state.compilation?.isValid ? state.compilation.applications : [], fileName: state.session.fileName });
  const topic = topics.find(item=>item.id===state.helpTopicId) ?? topics.find(item=>item.id==='start') ?? topics[0];
  state.helpTopicId = topic.id;
  const byId = new Map(topics.map(item => [item.id, item]));
  const searchText = new Map(topics.map(item => [item.id, helpSearchText(item)]));
  const related = (topic.related ?? []).filter(id => id !== topic.id && byId.has(id));
  const sectionMarkup = (section: HelpSection): string => `<section><h3>${escapeHtml(section.heading)}</h3>`
    + (section.paragraphs?.map(p=>`<p>${escapeHtml(p)}</p>`).join('') ?? '')
    + (section.steps ? `<ol>${section.steps.map(step=>`<li>${escapeHtml(step)}</li>`).join('')}</ol>` : '')
    + (section.terms ? `<dl class="help-terms">${section.terms.map(term=>`<div><dt>${term.code ? `<code>${escapeHtml(term.term)}</code>` : escapeHtml(term.term)}</dt><dd>${escapeHtml(term.meaning)}</dd></div>`).join('')}</dl>` : '')
    + '</section>';
  content.innerHTML = `<div class="help-page"><aside class="help-index" aria-label="Help topics"><label for="help-search">Find help</label><input id="help-search" type="search" placeholder="Search guides and this app" value="${escapeAttribute(state.helpQuery)}" />
    <div class="help-topics">${groupHelpTopics(topics).map((group, index)=>`<div class="help-group" role="group" aria-labelledby="help-group-${index}"><p id="help-group-${index}" class="help-group-label">${escapeHtml(group.category)}</p>${group.topics.map(item=>`<button type="button" data-help-topic="${escapeAttribute(item.id)}" ${item.id===topic.id ? 'aria-current="page"' : ''}><strong>${escapeHtml(item.title)}</strong></button>`).join('')}</div>`).join('')}</div><p id="help-no-results" hidden>No matching topics.</p></aside>
    <article class="help-article"><p class="location">${escapeHtml(topic.category)}</p><h2 id="help-article-title" tabindex="-1">${escapeHtml(topic.title)}</h2><p class="help-summary">${escapeHtml(topic.summary)}</p>
    ${topic.sections.map(sectionMarkup).join('')}
    ${topic.setupRequest ? `<section class="connection-request"><h3>Register with your client</h3><p>Run the line for your client once. It contains the address only; there is no secret.</p><textarea id="help-setup-request" readonly rows="3" aria-label="MCP registration commands">${escapeHtml(topic.setupRequest)}</textarea><button id="copy-help-request" type="button" class="secondary-button">Copy commands</button><p id="copy-help-status" role="status"></p></section>` : ''}
    ${related.length ? `<nav class="help-related" aria-label="Related topics"><h3>See also</h3>${related.map(id=>`<button type="button" class="help-link" data-help-topic="${escapeAttribute(id)}">${escapeHtml(byId.get(id)!.title)}</button>`).join('')}</nav>` : ''}
    <p class="help-footnote">Built-in guides are available offline. “About this app” follows the current file’s record types, fields and configured actions. Reopen Help after changing the app to refresh its reference.</p></article></div>`;
  // Search covers article bodies, so a refusal code or a screen label finds its topic; the query outlives a topic click.
  const applyFilter = (): void => {
    let matches = 0;
    for (const group of content.querySelectorAll<HTMLElement>('.help-group')) {
      let visible = 0;
      for (const button of group.querySelectorAll<HTMLButtonElement>('[data-help-topic]')) {
        button.hidden = !searchText.get(button.dataset.helpTopic!)!.includes(state.helpQuery);
        if (!button.hidden) visible++;
      }
      group.hidden = visible === 0;
      matches += visible;
    }
    requiredElement<HTMLElement>('#help-no-results').hidden = matches !== 0;
  };
  requiredElement<HTMLInputElement>('#help-search').addEventListener('input', (event)=>{
    state.helpQuery = (event.target as HTMLInputElement).value.trim().toLocaleLowerCase();
    applyFilter();
  });
  applyFilter();
  for (const button of content.querySelectorAll<HTMLButtonElement>('[data-help-topic]')) button.addEventListener('click', ()=>{
    const fromIndex = button.closest('.help-index') !== null;
    state.helpTopicId = button.dataset.helpTopic!; renderHelp();
    const article = content.querySelector<HTMLElement>('.help-article');
    if (article) article.scrollTop = 0;
    // The click destroyed the button, so hand focus on: to the new index entry, or to the article for a See-also link.
    (fromIndex ? content.querySelector<HTMLElement>('.help-index [aria-current]') : content.querySelector<HTMLElement>('#help-article-title'))?.focus();
  });
  content.querySelector('#copy-help-request')?.addEventListener('click', async ()=>{
    const request = requiredElement<HTMLTextAreaElement>('#help-setup-request');
    const status = requiredElement<HTMLElement>('#copy-help-status');
    try { await navigator.clipboard.writeText(request.value); status.textContent = 'Copied. Run the line for your client in a terminal.'; }
    catch { request.focus(); request.select(); status.textContent = 'Press Ctrl+C to copy the selected commands, then run the line for your client in a terminal.'; }
  });
}

