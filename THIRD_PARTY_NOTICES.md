# Bundled third-party code

The standalone HTML embeds the following fixed versions. They execute locally and do not fetch code from a CDN at runtime. The complete licenses are preserved in `vendor/` and embedded as comments in the generated HTML.

## Paper.js 0.12.18

- Purpose: cubic path boolean operations and SVG vector parsing.
- Project: https://github.com/paperjs/paper.js
- Distribution: https://cdn.jsdelivr.net/npm/paper@0.12.18/dist/paper-core.min.js
- Local file: `vendor/paper-core-0.12.18.min.js`
- License: MIT; see `vendor/paper-LICENSE.txt`.
- Copyright (c) 2011–2020 Jürg Lehni & Jonathan Puckey.

## fflate 0.8.2

- Purpose: offline ZIP generation for folder exports.
- Project: https://github.com/101arrowz/fflate
- Distribution: https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.js
- Local file: `vendor/fflate-0.8.2.js`
- License: MIT; see `vendor/fflate-LICENSE.txt`.
- Copyright (c) 2023 Arjun Barrett.

## Noto Sans Symbols 2 v2.008 icon outlines

- Purpose: source outlines for a small set of UI icons, exported to SVG and embedded in the application.
- Project: https://github.com/notofonts/symbols
- Copyright: Copyright 2022 The Noto Project Authors.
- License: SIL Open Font License 1.1; see `assets/Noto-Sans-Symbols-OFL.txt`.
- Source glyphs: U+003F, U+2316, U+25A6, U+25AD, U+2702, U+270B, U+2712, U+2715, U+27A1, U+2B2D, U+1F5C1.
- Derived asset: `assets/noto-symbols.svg`.

The original OTF is not distributed. The SVG contains only the converted outline paths used by the interface.

`vendor/checksums.json` records the SHA-256 hashes of the bundled files. No external font editor source code is bundled. The higher-degree model, conversion, file adapters, editor interaction and project state modules are maintained in this repository.
