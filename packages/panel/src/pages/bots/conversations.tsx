import { Pagination } from "@/components/ui/pagination";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { client } from "@/lib/client";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp, Loader2, MessageSquare, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useParams } from "react-router";

interface ConversationItem {
  chatId: number;
  messageCount: number;
  lastActive: string;
}

interface ConversationMessage {
  id: number;
  role: string;
  content: string;
  userId: number | null;
  userName: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

const COLLAPSE_LINE_THRESHOLD = 4;

function CollapsibleContent({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const lines = content.split("\n");
  const shouldCollapse = lines.length > COLLAPSE_LINE_THRESHOLD;

  if (!shouldCollapse) {
    return <p className="text-sm whitespace-pre-wrap">{content}</p>;
  }

  const preview = lines.slice(0, COLLAPSE_LINE_THRESHOLD).join("\n");

  return (
    <div>
      <p className="text-sm whitespace-pre-wrap">{expanded ? content : `${preview}\n...`}</p>
      <button
        type="button"
        className="mt-1 flex items-center gap-1 text-xs opacity-60 hover:opacity-100"
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? (
          <>
            <ChevronUp className="h-3 w-3" /> Collapse
          </>
        ) : (
          <>
            <ChevronDown className="h-3 w-3" /> Expand ({lines.length} lines)
          </>
        )}
      </button>
    </div>
  );
}

function UsageBadge({ meta }: { meta: Record<string, unknown> }) {
  const usage = meta.usage as Record<string, number> | undefined;
  const model = meta.model as string | undefined;
  const trigger = meta.trigger as string | undefined;

  if (!usage && !model) return null;

  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {model && (
        <span className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[10px] dark:bg-white/10">
          {model}
        </span>
      )}
      {trigger && (
        <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] dark:bg-white/10">
          trigger: {trigger}
        </span>
      )}
      {usage && (
        <span className="rounded bg-black/5 px-1.5 py-0.5 font-mono text-[10px] dark:bg-white/10">
          {usage.prompt_tokens}+{usage.completion_tokens}={usage.total_tokens} tokens
        </span>
      )}
    </div>
  );
}

function ToolCallContent({ meta }: { meta: Record<string, unknown> }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = meta.toolName as string;
  const args = meta.args as string | undefined;

  let parsedArgs: string | undefined;
  if (args) {
    try {
      parsedArgs = JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      parsedArgs = args;
    }
  }

  return (
    <div>
      <p className="text-sm font-medium">{toolName}()</p>
      {parsedArgs && (
        <>
          <button
            type="button"
            className="mt-1 flex items-center gap-1 text-xs opacity-60 hover:opacity-100"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <>
                <ChevronUp className="h-3 w-3" /> Hide args
              </>
            ) : (
              <>
                <ChevronDown className="h-3 w-3" /> Show args
              </>
            )}
          </button>
          {expanded && (
            <pre className="mt-1 max-h-60 overflow-auto rounded bg-black/5 p-2 font-mono text-xs dark:bg-white/5">
              {parsedArgs}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

const roleStyles: Record<string, string> = {
  user: "bg-blue-500/10 text-blue-700 dark:text-blue-300",
  assistant: "bg-green-500/10 text-green-700 dark:text-green-300",
  context: "bg-zinc-500/10 text-zinc-600 dark:text-zinc-400",
  system: "bg-purple-500/10 text-purple-700 dark:text-purple-300",
  tool_call: "bg-orange-500/10 text-orange-700 dark:text-orange-300",
  tool_result: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
};

const roleLabels: Record<string, string> = {
  user: "User",
  assistant: "AI",
  context: "Context",
  system: "System",
  tool_call: "Tool Call",
  tool_result: "Tool Result",
};

function MessageBubble({ msg }: { msg: ConversationMessage }) {
  const isToolCall = msg.role === "tool_call" && msg.meta;
  const isAssistantWithMeta = msg.role === "assistant" && msg.meta;
  const needsCollapse =
    msg.role === "system" || msg.role === "tool_result" || msg.role === "context";

  return (
    <div className={cn("rounded-md p-3", roleStyles[msg.role] ?? "bg-zinc-100 dark:bg-zinc-800")}>
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium">
          {roleLabels[msg.role] ?? msg.role}
          {msg.userName && ` (${msg.userName})`}
          {isToolCall && msg.meta && (
            <span className="ml-1 font-mono">{msg.meta.toolName as string}</span>
          )}
        </span>
        <span className="text-xs opacity-60">{new Date(msg.createdAt).toLocaleString()}</span>
      </div>

      {isToolCall ? (
        <ToolCallContent meta={msg.meta!} />
      ) : needsCollapse ? (
        <CollapsibleContent content={msg.content} />
      ) : (
        <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
      )}

      {isAssistantWithMeta && <UsageBadge meta={msg.meta!} />}
    </div>
  );
}

export function BotConversationsPage() {
  const { botId } = useParams<{ botId: string }>();
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedChat, setSelectedChat] = useState<number | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [msgTotal, setMsgTotal] = useState(0);
  const [msgPage, setMsgPage] = useState(1);
  const [msgLoading, setMsgLoading] = useState(false);

  const limit = 20;
  const msgLimit = 50;

  const loadConversations = useCallback(async () => {
    if (!botId) return;
    setLoading(true);
    try {
      const res = await client.api.bots[":botId"].conversations.$get({
        param: { botId },
        query: { page: String(page), limit: String(limit) },
      });
      const json = await res.json();
      if (json.ok) {
        setConversations(json.data);
        setTotal(json.total);
      }
    } catch (err) {
      console.error("Failed to load conversations:", err);
    } finally {
      setLoading(false);
    }
  }, [botId, page]);

  const loadMessages = useCallback(async () => {
    if (!botId || selectedChat === null) return;
    setMsgLoading(true);
    try {
      const res = await client.api.bots[":botId"].conversations[":chatId"].$get({
        param: { botId, chatId: String(selectedChat) },
        query: { page: String(msgPage), limit: String(msgLimit) },
      });
      const json = await res.json();
      if (json.ok) {
        setMessages(json.data as ConversationMessage[]);
        setMsgTotal(json.total);
      }
    } catch (err) {
      console.error("Failed to load messages:", err);
    } finally {
      setMsgLoading(false);
    }
  }, [botId, selectedChat, msgPage]);

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  useEffect(() => {
    if (selectedChat !== null) {
      loadMessages();
    }
  }, [loadMessages, selectedChat]);

  const handleClearAll = async () => {
    if (!botId || !window.confirm("确定要清空该 Bot 的所有对话历史吗？")) return;
    try {
      await client.api.bots[":botId"].conversations.$delete({ param: { botId } });
      setConversations([]);
      setTotal(0);
      setSelectedChat(null);
      setMessages([]);
    } catch (err) {
      console.error("Failed to clear conversations:", err);
    }
  };

  const handleClearChat = async (chatId: number) => {
    if (!botId || !window.confirm(`确定要清空 Chat ${chatId} 的对话历史吗？`)) return;
    try {
      await client.api.bots[":botId"].conversations[":chatId"].$delete({
        param: { botId, chatId: String(chatId) },
      });
      setConversations((prev) => prev.filter((c) => c.chatId !== chatId));
      if (selectedChat === chatId) {
        setSelectedChat(null);
        setMessages([]);
      }
    } catch (err) {
      console.error("Failed to clear chat:", err);
    }
  };

  const totalPages = Math.ceil(total / limit);
  const msgTotalPages = Math.ceil(msgTotal / msgLimit);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Conversations</h1>
        {conversations.length > 0 && (
          <Button variant="destructive" size="sm" onClick={handleClearAll}>
            <Trash2 className="h-4 w-4" />
            Clear All
          </Button>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Conversation list */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Conversations {total > 0 && `(${total})`}</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : conversations.length === 0 ? (
              <p className="text-muted-foreground py-8 text-center text-sm">No conversations yet</p>
            ) : (
              <div className="space-y-2">
                {conversations.map((conv) => (
                  <div
                    key={conv.chatId}
                    className={cn(
                      "flex cursor-pointer items-center justify-between rounded-md border p-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800",
                      selectedChat === conv.chatId &&
                        "border-blue-500 bg-blue-50 dark:bg-blue-900/20",
                    )}
                    onClick={() => {
                      setSelectedChat(conv.chatId);
                      setMsgPage(1);
                    }}
                  >
                    <div className="flex items-center gap-3">
                      <MessageSquare className="text-muted-foreground h-4 w-4" />
                      <div>
                        <p className="font-mono text-sm font-medium">{conv.chatId}</p>
                        <p className="text-muted-foreground text-xs">
                          {conv.messageCount} messages
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground text-xs">
                        {new Date(conv.lastActive).toLocaleString()}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleClearChat(conv.chatId);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-red-500" />
                      </Button>
                    </div>
                  </div>
                ))}

                <Pagination
                  page={page}
                  totalPages={totalPages}
                  onPageChange={setPage}
                  className="flex items-center justify-center gap-2 pt-2"
                />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Message detail */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {selectedChat !== null ? `Chat ${selectedChat}` : "Select a conversation"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {selectedChat === null ? (
              <p className="text-muted-foreground py-8 text-center text-sm">
                Click a conversation to view messages
              </p>
            ) : msgLoading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            ) : messages.length === 0 ? (
              <p className="text-muted-foreground py-8 text-center text-sm">No messages</p>
            ) : (
              <div className="space-y-3">
                {messages.map((msg) => (
                  <MessageBubble key={msg.id} msg={msg} />
                ))}

                <Pagination
                  page={msgPage}
                  totalPages={msgTotalPages}
                  onPageChange={setMsgPage}
                  className="flex items-center justify-center gap-2 pt-2"
                />
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
