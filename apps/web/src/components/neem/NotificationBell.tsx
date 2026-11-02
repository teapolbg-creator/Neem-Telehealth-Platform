import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Bell } from "lucide-react";
import { useFeed, useMarkFeedRead } from "@/features/notifications/api";
import { sinceLabel } from "@/features/operations/api";

/**
 * What has happened that concerns this person (slice 5b, brief §9, D92).
 * Each entry leads to the work itself, which is the record of it.
 */
export function NotificationBell() {
  const feed = useFeed(true);
  const markRead = useMarkFeedRead();
  const [open, setOpen] = useState(false);
  const unread = feed.data?.unread ?? 0;

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications, ${unread} new` : "Notifications"}
        aria-expanded={open}
        onClick={() => {
          if (!open && unread > 0) markRead.mutate();
          setOpen(!open);
        }}
        className="relative rounded-lg p-2 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700"
      >
        <Bell className="size-4" />
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-white shadow-lg">
          <p className="border-b border-border px-4 py-2.5 text-sm font-bold">Notifications</p>
          {feed.data && feed.data.items.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">Nothing yet.</p>
          ) : null}
          {feed.error ? (
            <p className="p-4 text-sm text-slate-500">Notifications could not be loaded.</p>
          ) : null}
          <ul className="max-h-96 divide-y divide-border overflow-y-auto">
            {feed.data?.items.map((item) => {
              const body = (
                <>
                  <span className="block text-sm font-semibold">{item.label}</span>
                  {item.detail ? (
                    <span className="block truncate text-xs text-slate-600">{item.detail}</span>
                  ) : null}
                  <span className="block text-xs text-slate-400">
                    {sinceLabel(item.occurredAt)}
                  </span>
                </>
              );
              return (
                <li key={item.id}>
                  {item.href ? (
                    <Link
                      to={item.href as never}
                      onClick={() => setOpen(false)}
                      className="block px-4 py-2.5 hover:bg-slate-50"
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className="px-4 py-2.5">{body}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
