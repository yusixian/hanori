import { i18n } from "@/i18n";
import { harness as harnessEn } from "@/i18n/locales/en/harness";
import { harness as harnessZhCN } from "@/i18n/locales/zh-CN/harness";

if (!i18n.hasResourceBundle("en", "harness")) {
  i18n.addResourceBundle("en", "harness", harnessEn);
}
if (!i18n.hasResourceBundle("zh-CN", "harness")) {
  i18n.addResourceBundle("zh-CN", "harness", harnessZhCN);
}
