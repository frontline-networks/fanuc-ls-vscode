const test = require('node:test');
const assert = require('node:assert');
const D = require('../out/docsCore');

const pages = D.chunkPages('/h/TP.pdf', [
	'Kapitel 4 Programmanweisungen\nSKIP CONDITION\nDie Anweisung SKIP CONDITION legt die Bedingung fest.\nBeispiel: SKIP CONDITION DI[1]=ON',
	'Kapitel 9 Alarmcodes\nFILE-097 Zu viele Argumente\nUrsache: In der ARGDISP-Datei sind mehr als 30 Argumente definiert.',
	'',
	'Kapitel 5 Register\nOFFSET CONDITION PR[n] setzt einen Versatz für folgende Bewegungen.'
]);
const notes = D.chunkText('/h/Notizen.md', '# Zellennotizen\n\n## Greifer\nDO[12] Greifer zu.\n\n## Schweißen\nArc Start[1] Schweißprozedur 1 für Kehlnähte.\n');
const all = [...pages, ...notes];

test('Abschnitte aus PDF-Seiten und Markdown (#13)', () => {
	assert.deepStrictEqual(pages.map((p) => p.page), [1, 2, 4]);
	assert.deepStrictEqual(notes.map((n) => n.title), ['Zellennotizen', 'Greifer', 'Schweißen']);
	assert.deepStrictEqual(notes.map((n) => n.line), [0, 2, 5]);
});

test('Suche nach Befehlen, Alarmcodes und Umlauten', () => {
	assert.strictEqual(D.search(all, 'SKIP CONDITION')[0].chunk.page, 1);
	assert.strictEqual(D.search(all, 'file-097')[0].chunk.page, 2);
	const cond = D.search(all, 'condition');
	assert.deepStrictEqual(cond.map((h) => h.chunk.page).sort(), [1, 4]);
	assert.strictEqual(cond[0].chunk.page, 1, 'häufiger Treffer zuerst');
	// Umlaute: "fuer" findet "für", "Schweissen" findet "Schweißen"
	assert.strictEqual(D.search(all, 'Versatz fuer')[0].chunk.page, 4);
	assert.strictEqual(D.search(all, 'Schweissprozedur')[0].chunk.title, 'Schweißen');
	assert.deepStrictEqual(D.search(all, 'gibtsnicht'), []);
	assert.deepStrictEqual(D.search(all, 'der die das'), []);
});

test('Auszug um die Fundstelle', () => {
	const hit = D.search(all, 'Argumente definiert')[0];
	assert.match(hit.snippet, /30 Argumente definiert/);
	assert.strictEqual(D.matchLine(pages[1].text, 'Ursache'), 2);
	assert.strictEqual(D.matchLine(pages[1].text, 'Argumente definiert'), 2);
});
