export interface StyleDef {
  key: string;
  label: string;
  /** Extra hint for AI tool description (not shown to users). */
  hint?: string;
}

export const AVAILABLE_STYLES: StyleDef[] = [
  { key: "low-saturation-expressive-eyes", label: "低饱和透明感" },
  { key: "colored-pencil-grain", label: "缤纷彩铅" },
  { key: "grey-blocks-lineless", label: "灰色晕染" },
  { key: "oil-watercolor-blend", label: "水感油彩" },
  { key: "hard-line-monochrome-accent", label: "极简时尚" },
  { key: "korean-style", label: "精致韩漫" },
  { key: "lineart-watercolor-airy", label: "柔光线条" },
  { key: "minimal-flat-color", label: "极简色块" },
  { key: "luminous-retro-impasto", label: "明亮厚涂" },
  { key: "anime-watercolor-impasto", label: "水彩光晕" },
  { key: "high-contrast-retro-vivid", label: "明亮霓虹" },
  { key: "flat-anime-pastel", label: "柔和平涂" },
  { key: "paper-watercolor", label: "亮系水彩" },
  { key: "classic-japanese", label: "经典动画" },
  { key: "retro-tv-anime", label: "90复古赛璐璐" },
  { key: "poster-graffiti", label: "霓彩海报" },
  { key: "clean-flat-illustration", label: "简约平涂" },
  { key: "art-crayon", label: "画艺蜡笔" },
  { key: "painterly-doodle", label: "纹理涂鸦" },
  { key: "retro-comic-fusion", label: "复古混搭" },
  { key: "pencil-sketch", label: "铅绘素描" },
  { key: "chibi", label: "Q版" },
  { key: "retro-oil-glamour", label: "复古油亮肉感", hint: "适合性感/涩图" },
  { key: "modern-oil-glamour", label: "现代油亮肉感", hint: "适合性感/涩图" },
  { key: "bold-line-soft-color", label: "厚线柔和" },
  { key: "glossy-glass-anime", label: "琉璃动画" },
  { key: "moe-pastel", label: "萌系平涂" },
  { key: "semi-realistic", label: "半写实" },
  { key: "cool-warm-oil-contrast", label: "撞色厚涂" },
];
