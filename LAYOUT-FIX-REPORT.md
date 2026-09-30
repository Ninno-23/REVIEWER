# StudyVault v151.7 — Tool positioning & alignment

## What felt off
Composer tools sat slightly uneven: the attach control is a `<label>` while the others are `<button>`s, so size/baseline could drift. Order mixed “create image” before “attach photo,” which is less natural when you are just adding something.

## Order (left → right)
1. **＋ Attach** — files / PDFs / images  
2. **📷 Photo** — attach a photo for vision or editing  
3. **🖼 Create image** — generate or edit with AI  
4. **🎙 Voice** — speak instead of type  
5. **Stop / Send** on the right

## Alignment fixes
- One shared box model for every tool (38×38, grid centering, same border/padding).
- Label styled to match button metrics exactly.
- Soft group background behind the left tools so they read as one ordered row.
- Focus-visible rings for keyboard users.
- Sidebar tools keep even vertical spacing with status pinned at the bottom.
- Mobile: slightly tighter gap, same alignment rules.

## Code
- HTML: tool order + `role="group"` + consistent icon spans.
- CSS: dedicated v151.7 block at the end of `styles.css` (wins over older rules).
- JavaScript IDs unchanged — no behavior regression.

## Validation
- Syntax of HTML structure preserved
- Existing `#gptFileInput`, `#gptPhotoBtn`, `#tutorImage`, `#gptMicBtn`, `#tutorSend`, `#tutorStop` IDs kept
