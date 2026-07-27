import { i18n } from "@/i18n";
import { miniApp as miniAppEn } from "@/i18n/locales/en/mini-app";
import { miniApp as miniAppZhCN } from "@/i18n/locales/zh-CN/mini-app";

if (!i18n.hasResourceBundle("en", "miniApp")) {
  i18n.addResourceBundle("en", "miniApp", miniAppEn);
}
if (!i18n.hasResourceBundle("zh-CN", "miniApp")) {
  i18n.addResourceBundle("zh-CN", "miniApp", miniAppZhCN);
}
