# Hanori artwork

`hanori-sakura-v1.webp` is owner-generated artwork supplied for Hanori, created with
PixAI Tsubaki.3 v1 using the Semi Glow Enhancer and 卡哇伊风格 recipes. It is a brand
illustration rather than a built-in chat character. It does not incorporate the
blog screenshots used as visual references.

The runtime asset is a 1536 × 1024 WebP (quality 85), shared by the panel and public
documentation. Keep the original output and private generation records outside
the public source snapshot. The original PNG remains unchanged.

On desktop, preserve the wide composition and sky on the left. On narrow screens,
keep the face, flower hair clip and greeting hand visible when cropping. Place
interface copy in HTML rather than baking it into the image.

## Logo and social previews

The existing `../icon.svg` is the Hanori mark: sakura petals around a smiling
conversation bubble. It is shared by the panel and documentation navigation.
The PNG exports use the same mark on the brand's warm white background:

- `hanori-logo.png`: 512 × 512 for repository and project profiles.
- `icon-32.png`: 32 × 32 fallback favicon.
- `apple-touch-icon.png`: 180 × 180 home-screen icon.
- `social-card.png`: 1200 × 630 Open Graph / Twitter card.

Regenerate from the repository root with
`node packages/docs/scripts/render-brand.mjs` after installing dependencies and
Playwright Chromium. The script renders the local vector and text without
network assets; system fonts can change text metrics across platforms. Review
the output before committing. The social card uses the vector mark, not the
character illustration, and contains no deployment address.
