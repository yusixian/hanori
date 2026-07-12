import { Select } from "@/components/ui/select";
import { getResolvedLocale, type SupportedLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";

interface LanguageSwitcherProps {
  className?: string;
  selectClassName?: string;
}

export function LanguageSwitcher({ className, selectClassName }: LanguageSwitcherProps) {
  const { t, i18n } = useTranslation("common");
  const locale = getResolvedLocale();

  return (
    <label className={className}>
      <span className="sr-only">{t("language.label")}</span>
      <Select
        className={cn(
          "border-input h-9 min-w-28 rounded-lg border bg-white/90 px-2.5 text-xs font-medium shadow-sm backdrop-blur",
          selectClassName,
        )}
        value={locale}
        onChange={(event) => void i18n.changeLanguage(event.target.value as SupportedLocale)}
        aria-label={t("language.label")}
      >
        <option value="en">{t("language.english")}</option>
        <option value="zh-CN">{t("language.simplifiedChinese")}</option>
      </Select>
    </label>
  );
}
