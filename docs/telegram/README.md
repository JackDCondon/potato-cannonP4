# Telegram Integration (Windows, Topics/Threads Setup)

Potato Cannon can send questions to Telegram while it works. In the new setup, each ticket/brainstorm can get its own **Telegram Topic** (thread) inside a forum-enabled supergroup.

If `forumGroupId` is configured, Potato Cannon uses topics.  
If `forumGroupId` is not configured, it falls back to a direct message chat using `userId`.

## What You Need

- A running Potato Cannon daemon
- A Telegram account
- Permission to create/manage a Telegram group
- A bot token from BotFather
- Your Telegram user ID

## 1. Create the Telegram Bot

1. Open Telegram and chat with [@BotFather](https://t.me/botfather).
2. Run `/newbot`.
3. Follow prompts for bot name and username.
4. Copy the bot token (`123456:ABC-DEF...`).

## 2. Get Your Telegram User ID

1. Open [@userinfobot](https://t.me/userinfobot).
2. Press **Start**.
3. Copy your numeric user ID (example: `123456789`).

Use this for `telegram.userId`.

## 3. Create a Forum-Enabled Group (Topics)

1. In Telegram (Desktop or mobile), create a **new group**.
2. Convert it to a **Supergroup** if Telegram prompts you.
3. Enable **Topics** for the group:
   - Group info -> **Edit** -> **Topics** -> turn on.
4. Add your bot to the group.
5. Promote the bot to **Administrator**.

Why admin rights matter: Potato Cannon creates and manages forum topics via Telegram API (`createForumTopic`, `deleteForumTopic`).

## 4. Get the Forum Group Chat ID (`forumGroupId`)

`forumGroupId` for supergroups usually looks like `-100...`.

Fast method:
1. Post any message in the group.
2. In a browser, open:
   `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Find the group chat object in the JSON and copy `chat.id` (example: `-1001234567890`).

Use that value as `telegram.forumGroupId`.

## 5. Configure Potato Cannon on Windows

Config file location on Windows:

`C:\Users\<YourUser>\.potato-cannon\config.json`

Add/update `telegram`:

```json
{
  "telegram": {
    "botToken": "123456:ABC-DEF...",
    "userId": "123456789",
    "forumGroupId": "-1001234567890",
    "mode": "auto",
    "threadedWorkflow": true,
    "includeTicketContext": true,
    "flowControl": {
      "maxPendingPerTicket": 1,
      "maxPendingGlobal": 2
    }
  },
  "daemon": {
    "port": 8443
  }
}
```

### Field Reference

| Field | Required | Purpose |
|---|---|---|
| `botToken` | Yes | Bot token from BotFather |
| `userId` | Yes | Your Telegram user ID |
| `forumGroupId` | Recommended | Enables forum topic/thread mode |
| `mode` | No (`auto`) | Provider mode (`auto`, `polling`, `webhook`) |
| `threadedWorkflow` | Optional | Enables threaded workflow behavior in Telegram config |
| `includeTicketContext` | Optional | Includes more context in Telegram prompts |
| `flowControl.maxPendingPerTicket` | Optional | Max pending questions per ticket |
| `flowControl.maxPendingGlobal` | Optional | Max pending questions globally |

## 6. Restart on Windows

If running from terminal:

```powershell
potato-cannon stop
potato-cannon start
```

If running the desktop app, fully quit and reopen it.

## 7. Verify It Works

1. Start a new brainstorm/ticket flow.
2. Watch Telegram:
   - In forum mode, a new topic should appear in your group.
   - You should see a start message: "Potato Cannon ... Starting work on ..."
3. When a question is asked, answer in that same topic thread.

## Troubleshooting

### Bot sends DM, not topics

- Cause: `forumGroupId` missing/invalid.
- Fix: set `telegram.forumGroupId` to the supergroup chat ID (`-100...`), restart daemon.

### No topic creation

- Cause: group is not forum-enabled or bot lacks admin rights.
- Fix: enable Topics in group settings and promote bot to admin.

### Replies are ignored

- Cause: reply sent in the wrong chat/topic.
- Fix: reply in the exact topic that Potato Cannon created for that ticket.

### `getUpdates` returns no group chat

- Cause: bot has never received an update from that group.
- Fix: send a message in the group, mention the bot once, then call `getUpdates` again.

## Security Notes

- Keep `botToken` private.
- Do not commit your local `config.json` with real credentials.

---

Once this is set, Telegram topic/thread routing is automatic: Potato Cannon maps each ticket/brainstorm to a provider route and reuses it across restarts.
