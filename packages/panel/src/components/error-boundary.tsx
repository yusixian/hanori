import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { i18n } from "@/i18n";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen items-center justify-center p-8">
          <div className="max-w-md space-y-4 text-center">
            <h1 className="text-2xl font-bold">{i18n.t("errors.unexpectedTitle")}</h1>
            <p className="text-muted-foreground text-sm">{this.state.error?.message}</p>
            <button
              type="button"
              className="bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer rounded-md px-4 py-2 text-sm font-medium"
              onClick={() => window.location.reload()}
            >
              {i18n.t("errors.reloadPage")}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
