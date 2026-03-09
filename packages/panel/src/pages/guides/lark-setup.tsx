import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "react-router";

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-3 text-base">
          <span className="bg-primary text-primary-foreground inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-bold">
            {number}
          </span>
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm leading-relaxed">{children}</CardContent>
    </Card>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return <code className="bg-muted rounded px-1.5 py-0.5 font-mono text-xs">{children}</code>;
}

export function LarkSetupGuidePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Lark Webhook Bot Setup Guide</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Step-by-step guide to create and configure a Lark/Feishu custom webhook bot.
        </p>
      </div>

      <div className="space-y-4">
        <Step number={1} title="Create a Custom Bot in Lark Group">
          <ol className="list-inside list-decimal space-y-2">
            <li>Open a Lark/Feishu group chat</li>
            <li>
              Click the group name at the top to open <strong>Group Settings</strong>
            </li>
            <li>
              Navigate to <strong>Bots</strong> section
            </li>
            <li>
              Click <strong>Add Bot</strong> and select <strong>Custom Bot</strong>
            </li>
            <li>Give your bot a name and optional description, then confirm</li>
          </ol>
        </Step>

        <Step number={2} title="Copy the Webhook URL">
          <p>
            After creation, Lark will display a <strong>Webhook URL</strong> like:
          </p>
          <div className="bg-muted mt-2 overflow-x-auto rounded-md p-3 font-mono text-xs">
            https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
          </div>
          <p className="mt-2">Copy this URL — you'll need it when adding the bot in the panel.</p>
        </Step>

        <Step number={3} title="Configure Signature Verification (Optional)">
          <p>
            For added security, you can enable <strong>Signature Verification</strong>:
          </p>
          <ol className="mt-2 list-inside list-decimal space-y-2">
            <li>
              In the bot settings dialog, find the <strong>Security Settings</strong> section
            </li>
            <li>
              Enable <strong>Signature Verification</strong>
            </li>
            <li>
              Copy the generated <strong>Sign Secret</strong> (starts with <Code>SEC</Code>)
            </li>
          </ol>
          <p className="text-muted-foreground mt-2">
            If you skip this, leave the Sign Secret field empty when creating the bot.
          </p>
        </Step>

        <Step number={4} title="Add the Bot in Panel">
          <p>Fill in the bot creation form with the following fields:</p>
          <div className="mt-3 space-y-2">
            <div className="flex gap-2">
              <span className="text-muted-foreground w-28 shrink-0 font-medium">Platform</span>
              <span>Select "Lark Webhook"</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-28 shrink-0 font-medium">Name</span>
              <span>A friendly name for your bot</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-28 shrink-0 font-medium">Webhook URL</span>
              <span>Paste the URL from Step 2</span>
            </div>
            <div className="flex gap-2">
              <span className="text-muted-foreground w-28 shrink-0 font-medium">Sign Secret</span>
              <span>Paste the secret from Step 3 (leave empty if not configured)</span>
            </div>
          </div>
        </Step>

        <Step number={5} title="Email Forwarding (Optional)">
          <p>
            You can configure the bot to monitor an email inbox via IMAP and forward matching emails
            to the Lark group. This is useful for forwarding GitHub notifications, alerts, etc.
          </p>

          <h4 className="mt-3 font-medium">Gmail IMAP Setup:</h4>
          <ol className="mt-1 list-inside list-decimal space-y-2">
            <li>
              Enable IMAP in Gmail: <strong>Settings</strong> &rarr;{" "}
              <strong>See all settings</strong> &rarr; <strong>Forwarding and POP/IMAP</strong>{" "}
              &rarr; Enable IMAP
            </li>
            <li>Enable 2-Step Verification on your Google Account (required for App Passwords)</li>
            <li>
              Go to{" "}
              <a
                href="https://myaccount.google.com/apppasswords"
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 underline underline-offset-2 dark:text-blue-400"
              >
                Google App Passwords
              </a>{" "}
              &rarr; Create a new app password (select "Mail")
            </li>
            <li>Copy the generated 16-character password — use this as the IMAP password</li>
          </ol>
          <div className="bg-muted mt-2 space-y-1 rounded-md p-3 font-mono text-xs">
            <div>
              Host: <strong>imap.gmail.com</strong>
            </div>
            <div>
              Port: <strong>993</strong>
            </div>
          </div>

          <h4 className="mt-3 font-medium">QQ Mail IMAP Setup:</h4>
          <ol className="mt-1 list-inside list-decimal space-y-2">
            <li>
              Go to QQ Mail &rarr; <strong>Settings</strong> &rarr; <strong>Accounts</strong>
            </li>
            <li>
              Enable <strong>IMAP/SMTP Service</strong>
            </li>
            <li>
              Generate an <strong>Authorization Code</strong> (this is your password, not your QQ
              password)
            </li>
          </ol>
          <div className="bg-muted mt-2 space-y-1 rounded-md p-3 font-mono text-xs">
            <div>
              Host: <strong>imap.qq.com</strong>
            </div>
            <div>
              Port: <strong>993</strong>
            </div>
          </div>

          <h4 className="mt-3 font-medium">Filter Configuration:</h4>
          <ul className="mt-1 list-inside list-disc space-y-1">
            <li>
              <strong>Sender Filter</strong> — e.g. <Code>notifications@github.com</Code>
            </li>
            <li>
              <strong>Subject Filter</strong> — e.g. <Code>pull request</Code>
            </li>
          </ul>
          <p className="text-muted-foreground mt-2">
            Only emails matching the filters will be forwarded.
          </p>
        </Step>

        <Step number={6} title="Test Your Bot">
          <ol className="list-inside list-decimal space-y-2">
            <li>Start the bot from the bot list page</li>
            <li>
              On the bot dashboard, click the <strong>Send Test</strong> button
            </li>
            <li>Check your Lark group — you should see a test message</li>
          </ol>
          <p className="text-muted-foreground mt-2">
            If the message doesn't appear, verify the Webhook URL and Sign Secret are correct.
          </p>
        </Step>
      </div>

      <div className="flex justify-center pt-2">
        <Link to="/bots/new">
          <Button size="lg">Create Lark Bot</Button>
        </Link>
      </div>
    </div>
  );
}
