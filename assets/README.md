# assets/

## icon.png — required

Drop a **512×512 RGBA PNG** here, named exactly `assets/icon.png`.

It is discovered **by convention**. There is no `icon` key in `swell.json` and nothing else
references it — the platform picks up `assets/icon.png` on `swell app push` and shows it in
**Apps** in the dashboard and in the App Store listing. Rename it, resize it, or put it in
another directory and the app simply has no icon, with no error to tell you why.

Checklist:

- 512×512 exactly, square.
- RGBA (transparent background), not indexed colour, not JPEG-in-a-.png.
- The vendor's own logo mark, not their wordmark — it renders small.
- Check the vendor's brand guidelines before shipping their mark.

Verify what you have before pushing:

```bash
file assets/icon.png
# assets/icon.png: PNG image data, 512 x 512, 8-bit/color RGBA, non-interlaced
```

Nothing else belongs in this directory. The starter deliberately ships no placeholder
binary — a generic icon that nobody notices is worse than a missing one.
