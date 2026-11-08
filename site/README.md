# skill-be documentation site

A [Starlight](https://starlight.astro.build) site, published to GitHub Pages at <https://ngwes.github.io/skill-be/>.

The content is **not** stored here. The repository `README.md` is the single source of truth (and keeps rendering on
GitHub and npm). `scripts/sync-content.mjs` turns it into the site's content before every build: the introduction,
"How it works" and "Install" make the home page, and every other `##` section gets a page of its own. It adds the page
titles as front matter, and keeps the links between sections working by pointing them at the page that holds the
heading. The generated files (`src/content/docs/`) are git-ignored. To change the documentation, edit the README.

Content that belongs to the README only (such as the link to this site, or the list of sections that the sidebar
replaces) goes between the `<!-- docs-site:skip-start -->` and `<!-- docs-site:skip-end -->` markers: it is removed
from the site.

## Commands

Run from this folder:

| Command           | What it does                                                         |
| :---------------- | :------------------------------------------------------------------- |
| `npm install`     | Install dependencies                                                 |
| `npm run dev`     | Sync the content, then serve the site at `localhost:4321/skill-be/`  |
| `npm run sync`    | Re-sync the content after editing the README during `dev`            |
| `npm run build`   | Sync the content, build the site into `./dist/` and check its links  |
| `npm run preview` | Serve the built site locally                                         |

`npm run build` fails when a link points to a page or an anchor that does not exist
([starlight-links-validator](https://github.com/HiDeoo/starlight-links-validator)). The validator only checks absolute
links, so the sync script generates links that include the `base` (see `site.mjs`).

The site has its own `package.json` and is not part of the published package: the root `npm ci`, `npm test` and
`npm run build` do not touch it.

## Theme

The look follows the skill-be style guide (CRT terminal, crisp pixels, restrained neon), in a dark and a light theme:

- `src/styles/skill-be.css` sets Starlight's colour and font variables, the stepped corners of the frames and the
  header. Phosphor green is the identity and the structure, amber a small accent, and one muted red is kept for
  blocking states; cyan and magenta are left out, since they mean baseline and with skill in skill-be's reports.
  Every text colour reaches WCAG AA in both themes.
- `ec.config.mjs` and `src/code-themes.mjs` theme the code blocks (Expressive Code).
- `src/assets/skill-be-icon.png` is the header icon: `public/favicon.png` reduced to 40x40 and drawn with square
  pixels.

The fonts are self-hosted from npm packages, with no request to Google Fonts: IBM Plex Mono
([@fontsource/ibm-plex-mono](https://www.npmjs.com/package/@fontsource/ibm-plex-mono), © IBM Corp.) for the text and
the code, Press Start 2P ([@fontsource/press-start-2p](https://www.npmjs.com/package/@fontsource/press-start-2p),
© The Press Start 2P Project Authors) for the title, the short headings and labels. Both are under the SIL Open Font
License 1.1; their license texts are in `public/fonts/` and published with the site.

## Deployment

`.github/workflows/deploy-docs.yml` builds the site for every pull request and deploys it on every push to `main` that
touches the README or this folder. It needs **Settings → Pages → Source: GitHub Actions** to be enabled once on the
repository.
