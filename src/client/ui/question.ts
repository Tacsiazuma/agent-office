import type { AskQuestion, WorkerInfo, WorkerQuestion } from '../../shared/protocol';
import type { Net } from '../net';
import { h, openModal, type Modal } from './dom';

// A worker's AskUserQuestion, asked in the office instead of in its terminal: it waits with a ❓
// over its head until whoever opens its desk answers here (or throws the question away).

let open: { workerId: string; questionId: string; modal: Modal; gone(): void } | undefined;

/** Closes the question window of a worker whose question is gone (answered elsewhere, or the worker was interrupted). */
export function questionUpdate(w: WorkerInfo) {
  if (open && open.workerId === w.id && open.questionId !== w.question?.id) open.gone();
}

export function openQuestion(net: Net, w: WorkerInfo & { question: WorkerQuestion }) {
  if (open?.workerId === w.id && open.questionId === w.question.id) return;
  open?.modal.close();
  const q = w.question;
  const workerId = w.id;
  // Per question: the labels ticked, and what was typed as "Other".
  const picks = q.questions.map(() => new Set<string>());
  const others = q.questions.map(() => '');
  let done = false;
  let confirming = false;

  const answers = () => q.questions.map((_, i) => [...picks[i], ...(others[i].trim() ? [others[i].trim()] : [])]);
  const complete = () => answers().every((a) => a.length > 0);
  const send = (dismiss: boolean) => {
    done = true;
    net.send({ t: 'worker.answer', workerId, questionId: q.id, ...(dismiss ? { dismiss: true } : { answers: answers() }) });
    modal.close();
  };

  const submit = h('button.btn.primary', { type: 'submit' }, 'Answer ✨') as HTMLButtonElement;
  const body = h('div.body.ask-question');
  const footer = h('footer', {}, h('span.grow', {}, 'Esc or ✕ to put it aside'), submit);
  const form = h('form.modal', { role: 'dialog', 'aria-label': `${w.name} asks` }, h('header', {}, h('h2', {}, `❓ ${w.name} asks`)), body, footer) as HTMLFormElement;
  form.noValidate = true;

  const renderQuestion = (x: AskQuestion, i: number) => {
    const name = `ask-${q.id}-${i}`;
    const preview = h('pre.ask-preview');
    preview.hidden = true;
    const options = x.options.map((o) => {
      const input = h('input', { type: x.multiSelect ? 'checkbox' : 'radio', name, value: o.label }) as HTMLInputElement;
      input.addEventListener('change', () => {
        if (!x.multiSelect) picks[i].clear();
        if (input.checked) picks[i].add(o.label);
        else picks[i].delete(o.label);
        if (!x.multiSelect) others[i] = otherInput.value = '';
        sync();
      });
      const show = () => {
        preview.hidden = !o.preview;
        preview.textContent = o.preview ?? '';
      };
      const label = h('label.ask-option', { onmouseenter: show, onfocusin: show }, input, h('span', {}, h('b', {}, o.label), o.description ? h('small', {}, o.description) : null));
      return label;
    });
    const otherInput = h('input', { type: 'text', placeholder: 'Other…', 'aria-label': 'Other answer' }) as HTMLInputElement;
    otherInput.addEventListener('input', () => {
      others[i] = otherInput.value;
      // A single choice is either an option or your own words.
      if (!x.multiSelect && otherInput.value) {
        picks[i].clear();
        for (const r of document.getElementsByName(name)) (r as HTMLInputElement).checked = false;
      }
      sync();
    });
    return h('section.ask-q', {}, h('div.ask-head', {}, x.header ? h('span.ask-tag', {}, x.header) : null, h('p', {}, x.question)), h('div.ask-options', {}, ...options), preview, otherInput);
  };

  const sync = () => {
    submit.disabled = !complete();
  };
  const showQuestions = () => {
    body.replaceChildren(...q.questions.map(renderQuestion));
    footer.style.display = '';
    sync();
  };
  // The first ✕ / Esc asks before throwing the question away; a second one throws it away.
  const showConfirm = () => {
    body.replaceChildren(
      h('p', {}, `Throw away ${w.name}'s question? It goes on with its own best guess.`),
      h(
        'div.ask-confirm',
        {},
        h('button.btn', { type: 'button', onclick: () => ((confirming = false), showQuestions()) }, 'No, keep it'),
        h('button.btn.danger', { type: 'button', onclick: () => send(true) }, 'Yes, throw it away'),
      ),
    );
    footer.style.display = 'none';
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (complete()) send(false);
  });

  const modal = openModal(form, {
    doing: `answering ${w.name}`,
    canClose() {
      if (done || confirming) return true;
      confirming = true;
      showConfirm();
      return false;
    },
    onClose() {
      if (confirming && !done) send(true);
      if (open?.modal === modal) open = undefined;
    },
  });
  open = {
    workerId,
    questionId: q.id,
    modal,
    gone: () => {
      done = true;
      modal.close();
    },
  };
  showQuestions();
}
