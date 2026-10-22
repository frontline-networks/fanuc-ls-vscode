const test = require('node:test');
const assert = require('node:assert');
const F = require('../out/treeFilter');

test('Dateien nach Typ und Text filtern (#20)', () => {
	const names = ['HOME.LS', 'HOME.TP', 'ZAEHLER.PC', 'NUMREG.VR', 'IOSTATE.DG', 'DIOCFGSV.IO', 'README.XYZ'];
	const pick = (f) => names.filter((n) => F.matchesFileFilter(n, f));
	assert.deepStrictEqual(pick(F.NO_FILTER), names);
	assert.deepStrictEqual(pick({ groups: ['tp'], text: '' }), ['HOME.LS', 'HOME.TP']);
	assert.deepStrictEqual(pick({ groups: ['karel', 'io'], text: '' }), ['ZAEHLER.PC', 'DIOCFGSV.IO']);
	assert.deepStrictEqual(pick({ groups: ['other'], text: '' }), ['README.XYZ']);
	assert.deepStrictEqual(pick({ groups: [], text: 'home' }), ['HOME.LS', 'HOME.TP']);
	assert.deepStrictEqual(pick({ groups: [], text: '*.ls' }), ['HOME.LS']);
	assert.deepStrictEqual(pick({ groups: ['tp'], text: 'h?me*' }), ['HOME.LS', 'HOME.TP']);
	assert.ok(!F.isActive(F.NO_FILTER));
	assert.strictEqual(F.describeFilter({ groups: ['tp'], text: 'home' }), 'TP-Programme · „home“');
});
