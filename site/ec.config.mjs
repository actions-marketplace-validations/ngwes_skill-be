// Expressive Code (the code blocks), themed after the skill-be style guide. Starlight reads this
// file on its own. The frames get their stepped corners from src/styles/skill-be.css.
import { defineEcConfig } from '@astrojs/starlight/expressive-code';
import { skillBeDark, skillBeLight } from './src/code-themes.mjs';

// Square pixels for the terminal frame's three dots (the default draws circles)
const squareDots = `url("data:image/svg+xml,${encodeURIComponent(
	"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 60 16'><rect x='0' y='2' width='12' height='12'/><rect x='24' y='2' width='12' height='12'/><rect x='48' y='2' width='12' height='12'/></svg>",
)}")`;

export default defineEcConfig({
	// The first theme is the dark one; Starlight's theme switch picks between the two
	themes: [skillBeDark, skillBeLight],
	styleOverrides: {
		borderRadius: '0px',
		borderWidth: '2px',
		borderColor: 'var(--sb-frame-code)',
		codeFontFamily: 'var(--__sl-font-mono)',
		uiFontFamily: 'var(--__sl-font-mono)',
		uiFontSize: 'var(--sl-text-xs)',
		focusBorder: 'var(--sl-color-accent)',
		scrollbarThumbColor: 'var(--sb-frame-code)',
		scrollbarThumbHoverColor: 'var(--sl-color-accent)',
		frames: {
			frameBoxShadowCssValue: 'none',
			editorTabBarBackground: 'var(--sb-code-header)',
			editorTabBarBorderColor: 'var(--sb-frame-code)',
			editorTabBarBorderBottomColor: 'var(--sb-frame-code)',
			editorActiveTabBackground: 'var(--sb-code-bg)',
			editorActiveTabForeground: 'var(--sl-color-white)',
			editorActiveTabBorderColor: 'var(--sb-frame-code)',
			editorActiveTabIndicatorTopColor: 'var(--sl-color-accent)',
			editorActiveTabIndicatorHeight: '2px',
			terminalTitlebarBackground: 'var(--sb-code-header)',
			terminalTitlebarForeground: 'var(--sl-color-white)',
			terminalTitlebarBorderBottomColor: 'var(--sb-frame-code)',
			terminalTitlebarDotsForeground: 'var(--sb-frame-code)',
			terminalTitlebarDotsOpacity: '1',
			terminalIcon: squareDots,
			inlineButtonForeground: 'var(--sl-color-white)',
			inlineButtonBackground: 'var(--sl-color-white)',
			inlineButtonBorder: 'var(--sl-color-white)',
			tooltipSuccessBackground: 'var(--sl-color-accent-high)',
			tooltipSuccessForeground: 'var(--sl-color-text-invert)',
		},
		textMarkers: {
			lineDiffIndicatorMarginLeft: '0.25rem',
		},
	},
});
