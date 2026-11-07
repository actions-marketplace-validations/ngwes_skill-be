// Syntax highlighting themes for the code blocks, after the skill-be style guide.
//
// A terminal palette: phosphor green for keys and keywords, amber for strings, warm cream for the
// rest, a muted green-grey for comments. Cyan and magenta stay out of code (they mean baseline and
// with skill), and so does red (blocking states only). Every colour reaches WCAG AA on its code
// background (most reach 5.5:1, which is also Expressive Code's minimum contrast setting).
import { ExpressiveCodeTheme } from '@astrojs/starlight/expressive-code';

const theme = ({ name, type, bg, fg, c }) =>
	new ExpressiveCodeTheme({
		name,
		type,
		colors: {
			'editor.background': bg,
			'editor.foreground': fg,
			'editor.selectionBackground': c.selection,
			'editorLineNumber.foreground': c.comment,
		},
		tokenColors: [
			{ settings: { foreground: fg } },
			{ scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: c.comment, fontStyle: 'italic' } },
			{
				scope: ['string', 'string.unquoted', 'punctuation.definition.string', 'markup.inline.raw', 'markup.fenced_code'],
				settings: { foreground: c.string },
			},
			{
				scope: [
					'entity.name.tag',
					'support.type.property-name',
					'meta.object-literal.key',
					'variable.other.property',
					'entity.other.attribute-name',
				],
				settings: { foreground: c.key },
			},
			{
				scope: ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.control', 'keyword.operator.new'],
				settings: { foreground: c.keyword, fontStyle: 'bold' },
			},
			{
				scope: ['constant', 'constant.numeric', 'constant.language', 'support.constant', 'variable.other.constant'],
				settings: { foreground: c.constant },
			},
			{
				scope: ['entity.name.function', 'support.function', 'meta.function-call entity.name.function'],
				settings: { foreground: c.func },
			},
			{ scope: ['entity.name.type', 'support.type', 'support.class', 'entity.name.class'], settings: { foreground: c.type } },
			{ scope: ['punctuation', 'meta.brace', 'keyword.operator'], settings: { foreground: c.punctuation } },
			{ scope: ['variable.parameter', 'variable.other.normal.shell', 'variable.other'], settings: { foreground: fg } },
			{ scope: ['markup.heading', 'entity.name.section'], settings: { foreground: c.key, fontStyle: 'bold' } },
			{ scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
			{ scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
			{ scope: ['markup.underline.link', 'string.other.link'], settings: { foreground: c.key, fontStyle: 'underline' } },
			{ scope: ['markup.list', 'punctuation.definition.list'], settings: { foreground: c.keyword } },
		],
	});

// Dark: on Deep Ink
export const skillBeDark = theme({
	name: 'skill-be-dark',
	type: 'dark',
	bg: '#102A27',
	fg: '#E9E2D2',
	c: {
		comment: '#93A898',
		string: '#DBD089',
		key: '#9DBD94',
		keyword: '#9DBD94',
		constant: '#E8DFB0',
		func: '#F5EFE1',
		type: '#C6DABC',
		punctuation: '#B3C1B5',
		selection: '#2C4A40',
	},
});

// Light: on a darker step of Warm Cream
export const skillBeLight = theme({
	name: 'skill-be-light',
	type: 'light',
	bg: '#EDE6D4',
	fg: '#102A27',
	c: {
		comment: '#465A4F',
		string: '#625510',
		key: '#2C5126',
		keyword: '#2C5126',
		constant: '#5C4A0C',
		func: '#102A27',
		type: '#2B4A41',
		punctuation: '#3D524A',
		selection: '#D5CDB6',
	},
});
