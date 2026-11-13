/**
 * Smoke test de la paginación de horarios (fix del E2E 21/08: días con más
 * de 10 slots solo ofrecían los primeros 10 por el límite de items de
 * WhatsApp; ahora se pagina 9 + "Ver más horarios").
 *
 * Puro: sin DB ni red — messageBuilder y classifier solamente.
 *
 * Uso: node scripts/smoke-pagination.js
 */

import 'dotenv/config';
import { slotPageView, buildTimeSelectionMessage, SHOW_MORE_SLOTS_ID } from '../src/services/messageBuilder.js';
import { classifyShowMoreSlots, classifyTimeSelection } from '../src/services/classifier.js';
import { buttonLabels } from '../src/data/messages.js';

let passed = 0;
let failed = 0;
function expect(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name} ${detail}`);
  }
}

// 12 slots: el horario real de lunes-jueves (8:00–16:00 en bloques de 40).
const TWELVE = [
  '08:00', '08:40', '09:20', '10:00', '10:40', '11:20',
  '12:00', '12:40', '13:20', '14:00', '14:40', '15:20',
];
const TEN = TWELVE.slice(0, 10);
const DATE = '24/08/2026';

console.log('\n── slotPageView ──');

let view = slotPageView(TWELVE, 0);
expect('12 slots pág 0: 9 visibles', view.visible.length === 9 && view.visible[0] === '08:00' && view.visible[8] === '13:20');
expect('12 slots pág 0: hasMore y 2 páginas', view.hasMore === true && view.pageCount === 2);

view = slotPageView(TWELVE, 1);
expect('12 slots pág 1: los 3 restantes', view.visible.join(',') === '14:00,14:40,15:20');
expect('12 slots pág 1: sin más páginas', view.hasMore === false);

view = slotPageView(TWELVE, 7);
expect('página fuera de rango se clampa a la última', view.page === 1);

view = slotPageView(TEN, 0);
expect('10 slots: una sola página completa', view.visible.length === 10 && !view.hasMore && view.pageCount === 1);

console.log('\n── buildTimeSelectionMessage ──');

let msg = buildTimeSelectionMessage('5215512345678', DATE, 'lunes 24 de agosto', TWELVE, 0);
let ids = msg.sections[0].items.map((i) => i.id);
expect('pág 0: 9 slots + item Ver más', ids.length === 10 && ids[9] === SHOW_MORE_SLOTS_ID, JSON.stringify(ids));
expect('label del item Ver más', msg.sections[0].items[9].label === buttonLabels.moreSlots);
expect('body con pista de página 1 de 2', msg.body.includes('Página 1 de 2'));

msg = buildTimeSelectionMessage('5215512345678', DATE, 'lunes 24 de agosto', TWELVE, 1);
ids = msg.sections[0].items.map((i) => i.id);
expect('pág 1: solo los 3 restantes, sin Ver más', ids.length === 3 && ids.every((id) => id.startsWith('slot_')), JSON.stringify(ids));
expect('body con pista de página 2 de 2', msg.body.includes('Página 2 de 2'));

msg = buildTimeSelectionMessage('5215512345678', DATE, 'lunes 24 de agosto', TEN, 0);
expect('10 slots: los 10 sin Ver más ni pista', msg.sections[0].items.length === 10 && !msg.body.includes('Página'));

console.log('\n── classifiers ──');

const listReply = (id) => ({ inputType: 'list', listId: id, buttonPayload: null, text: '' });
const textMsg = (t) => ({ inputType: 'text', listId: null, buttonPayload: null, text: t });

expect('slot_more por list reply', classifyShowMoreSlots(listReply(SHOW_MORE_SLOTS_ID)));
expect('"ver más horarios" por texto', classifyShowMoreSlots(textMsg('Ver más horarios')));
expect('"más" por texto', classifyShowMoreSlots(textMsg('más')));
expect('texto normal no es show-more', !classifyShowMoreSlots(textMsg('a las 10')));
expect('un slot elegido no es show-more', !classifyShowMoreSlots(listReply(`slot_${DATE}_14:40`)));

const page1 = slotPageView(TWELVE, 1).visible;
expect('número "2" mapea contra la página visible', classifyTimeSelection(textMsg('2'), TWELVE, page1) === '14:40');
expect('hora escrita se acepta aunque no esté en la página', classifyTimeSelection(textMsg('08:40'), TWELVE, page1) === '08:40');
expect('list reply de un slot de otra página se acepta', classifyTimeSelection(listReply(`slot_${DATE}_15:20`), TWELVE, page1) === '15:20');
expect('slot no ofrecido se rechaza', classifyTimeSelection(textMsg('16:40'), TWELVE, page1) === null);

console.log(`\nResultado: ${passed} pass / ${failed} fail`);
process.exit(failed === 0 ? 0 : 1);
