---
description: "Tesseract languages: the bundled English and orientation models, language modules, and custom models"
sidebar_label: Languages and models
---

# Languages and models

> Examples assume this module is imported under the alias `Tesseract`. Substitute your own alias if you import it under a different name.

A recognizer reads with the language models it lists in `languages:`, in priority order, and every model is a resource referenced with `!ref`. There is no default language and no language code string: which models a recognizer loads is visible in the manifest and checked by `telo check`.

## Bundled

| Resource | Model |
| --- | --- |
| `Tesseract.eng` | English (`eng`), Latin script. |
| `Tesseract.osd` | Orientation and script detection, for `autoOsd` and `sparseTextOsd`. |

Both are the `4.0.0_best_int` models of `tesseract-ocr/tessdata`, shipped in this module's assets under the Apache-2.0 notice in `notices/tessdata.LICENSE`. Importing `tesseract` fetches the whole assets layer — the engine builds, `eng` and `osd`, about 17 MB — on first use.

## Other languages

Every other language Tesseract ships a model for is its own module, published as `oci://ghcr.io/telorun/tesseract-lang/<code>`, whose one exported resource is named after the code:

```yaml
imports:
  Tesseract: oci://ghcr.io/telorun/tesseract@0.1.0
  Deu: oci://ghcr.io/telorun/tesseract-lang/deu@0.1.0
  Fra: oci://ghcr.io/telorun/tesseract-lang/fra@0.1.0
---
kind: Tesseract.Recognizer
metadata: { name: recognizer }
languages: [!ref Deu.deu, !ref Fra.fra, !ref Tesseract.eng]
```

On the Telo hub the language modules are listed under the model kind they instantiate rather than as search results of their own: `find_instances` for `oci://ghcr.io/telorun/tesseract-model` and `Language` returns every one, and searching a language's name (`polish`) finds its model.

A language module imports only the model kinds, never the engine, so importing one opens no second engine and fetches only that language's model. The full list is [below](#all-languages).

Listing several languages makes each recognition consider all of them, so it is slower. List only the languages the images are written in, most likely first.

## Your own model

A custom or fine-tuned model is one declaration through the re-exported kind — no other import:

```yaml
kind: Tesseract.Language
metadata: { name: receipts }
code: eng_receipts
data: !module-path ./models/eng_receipts.traineddata
---
kind: Tesseract.Recognizer
metadata: { name: recognizer }
languages: [!ref receipts]
```

- `code` is the model's name as the engine knows it: the recognizer loads the model under it, and hOCR output reports it in each paragraph's and word's `lang`. It never reads the file name. A custom or fine-tuned model takes a name of its own (`eng_receipts`, not `eng`).
- `data` is the `.traineddata` file, gzip-compressed or raw: the recognizer tells them apart by the gzip header. Use `!module-path` for a file that ships with your module, or a host-path variable for one on the machine.
- Two models of one recognizer need two codes: `telo check` refuses a recognizer listing two models under one code (`RESOURCE_RULE_VIOLATED`, rule `LANGUAGE_CODE_DUPLICATE`), and the recognizer refuses it at start when `telo check` could not see both models.

A model file that is missing, unreadable, not valid gzip, or refused by the engine fails the recognizer's start with `ERR_MODEL_DATA_INVALID`, naming the model resource and its path.

The orientation model is declared the same way, as a `Tesseract.OrientationModel` with `data` only. A language model cannot stand in the `orientationModel` slot, nor the orientation model in `languages` — `telo check` refuses either.

## All languages

Each row is a module at `oci://ghcr.io/telorun/tesseract-lang/<code>` exporting one model named `<code>`. The table is written by the repository's generator from its language table.

<!-- languages:start -->
| Code | Language | Script |
| --- | --- | --- |
| `afr` | Afrikaans | Latin |
| `amh` | Amharic | Ethiopic |
| `ara` | Arabic | Arabic |
| `asm` | Assamese | Bengali |
| `aze` | Azerbaijani | Latin |
| `aze_cyrl` | Azerbaijani | Cyrillic |
| `bel` | Belarusian | Cyrillic |
| `ben` | Bengali | Bengali |
| `bod` | Tibetan | Tibetan |
| `bos` | Bosnian | Latin |
| `bre` | Breton | Latin |
| `bul` | Bulgarian | Cyrillic |
| `cat` | Catalan | Latin |
| `ceb` | Cebuano | Latin |
| `ces` | Czech | Latin |
| `chi_sim` | Chinese (Simplified) | Han |
| `chi_sim_vert` | Chinese (Simplified), vertical text | Han |
| `chi_tra` | Chinese (Traditional) | Han |
| `chi_tra_vert` | Chinese (Traditional), vertical text | Han |
| `chr` | Cherokee | Cherokee |
| `cos` | Corsican | Latin |
| `cym` | Welsh | Latin |
| `dan` | Danish | Latin |
| `deu` | German | Latin |
| `div` | Dhivehi | Thaana |
| `dzo` | Dzongkha | Tibetan |
| `ell` | Greek | Greek |
| `enm` | Middle English | Latin |
| `epo` | Esperanto | Latin |
| `est` | Estonian | Latin |
| `eus` | Basque | Latin |
| `fao` | Faroese | Latin |
| `fas` | Persian | Arabic |
| `fil` | Filipino | Latin |
| `fin` | Finnish | Latin |
| `fra` | French | Latin |
| `frk` | German Fraktur | Fraktur |
| `frm` | Middle French | Latin |
| `fry` | Western Frisian | Latin |
| `gla` | Scottish Gaelic | Latin |
| `gle` | Irish | Latin |
| `glg` | Galician | Latin |
| `grc` | Ancient Greek | Greek |
| `guj` | Gujarati | Gujarati |
| `hat` | Haitian Creole | Latin |
| `heb` | Hebrew | Hebrew |
| `hin` | Hindi | Devanagari |
| `hrv` | Croatian | Latin |
| `hun` | Hungarian | Latin |
| `hye` | Armenian | Armenian |
| `iku` | Inuktitut | Canadian Syllabics |
| `ind` | Indonesian | Latin |
| `isl` | Icelandic | Latin |
| `ita` | Italian | Latin |
| `ita_old` | Old Italian | Latin |
| `jav` | Javanese | Latin |
| `jpn` | Japanese | Japanese |
| `jpn_vert` | Japanese, vertical text | Japanese |
| `kan` | Kannada | Kannada |
| `kat` | Georgian | Georgian |
| `kat_old` | Old Georgian | Georgian |
| `kaz` | Kazakh | Cyrillic |
| `khm` | Khmer | Khmer |
| `kir` | Kyrgyz | Cyrillic |
| `kmr` | Northern Kurdish | Latin |
| `kor` | Korean | Hangul |
| `kor_vert` | Korean, vertical text | Hangul |
| `lao` | Lao | Lao |
| `lat` | Latin | Latin |
| `lav` | Latvian | Latin |
| `lit` | Lithuanian | Latin |
| `ltz` | Luxembourgish | Latin |
| `mal` | Malayalam | Malayalam |
| `mar` | Marathi | Devanagari |
| `mkd` | Macedonian | Cyrillic |
| `mlt` | Maltese | Latin |
| `mon` | Mongolian | Cyrillic |
| `mri` | Maori | Latin |
| `msa` | Malay | Latin |
| `mya` | Burmese | Myanmar |
| `nep` | Nepali | Devanagari |
| `nld` | Dutch | Latin |
| `nor` | Norwegian | Latin |
| `oci` | Occitan | Latin |
| `ori` | Odia | Odia |
| `pan` | Punjabi | Gurmukhi |
| `pol` | Polish | Latin |
| `por` | Portuguese | Latin |
| `pus` | Pashto | Arabic |
| `que` | Quechua | Latin |
| `ron` | Romanian | Latin |
| `rus` | Russian | Cyrillic |
| `san` | Sanskrit | Devanagari |
| `sin` | Sinhala | Sinhala |
| `slk` | Slovak | Latin |
| `slv` | Slovenian | Latin |
| `snd` | Sindhi | Arabic |
| `spa` | Spanish | Latin |
| `spa_old` | Old Spanish | Latin |
| `sqi` | Albanian | Latin |
| `srp` | Serbian | Cyrillic |
| `srp_latn` | Serbian | Latin |
| `sun` | Sundanese | Latin |
| `swa` | Swahili | Latin |
| `swe` | Swedish | Latin |
| `syr` | Syriac | Syriac |
| `tam` | Tamil | Tamil |
| `tat` | Tatar | Cyrillic |
| `tel` | Telugu | Telugu |
| `tgk` | Tajik | Cyrillic |
| `tha` | Thai | Thai |
| `tir` | Tigrinya | Ethiopic |
| `ton` | Tongan | Latin |
| `tur` | Turkish | Latin |
| `uig` | Uyghur | Arabic |
| `ukr` | Ukrainian | Cyrillic |
| `urd` | Urdu | Arabic |
| `uzb` | Uzbek | Latin |
| `uzb_cyrl` | Uzbek | Cyrillic |
| `vie` | Vietnamese | Latin |
| `yid` | Yiddish | Hebrew |
| `yor` | Yoruba | Latin |
<!-- languages:end -->
