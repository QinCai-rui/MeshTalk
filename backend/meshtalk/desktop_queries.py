"""Local desktop history/search IPC handlers. No network side effects."""
from .database import Database


def handlers(db: Database, local_peer_id: str) -> dict:
    def conversation(req):
        peer, group = req.get("peer_id"), req.get("group_id")
        for value in (peer, group):
            if value is not None and (not isinstance(value, str) or not value):
                raise ValueError("Conversation identifiers must be non-empty strings")
        if peer and group:
            raise ValueError("Specify peer_id or group_id, not both")
        return peer, group

    async def search(req):
        query, offset = req.get("query"), req.get("offset", 0)
        if not isinstance(query, str) or not query.strip() or len(query) > 256:
            raise ValueError("query must contain 1–256 characters")
        if type(offset) is not int or offset < 0:
            raise ValueError("offset must be a non-negative integer")
        peer, group = conversation(req)
        return await db.search_local_messages(local_peer_id, query.strip(), offset, peer, group)

    async def history(req):
        peer, group = conversation(req)
        if not peer and not group:
            raise ValueError("A conversation is required")
        before, around = req.get("before"), req.get("around")
        if before is not None and (type(before) is not int or before < 1):
            raise ValueError("before must be a positive integer")
        if around is not None and (not isinstance(around, str) or not around or len(around) > 128):
            raise ValueError("around must be a message identifier")
        return await db.desktop_history(local_peer_id, peer, group, before, around)

    async def drafts(req):
        value = req.get("drafts")
        if value is not None:
            if not isinstance(value, dict) or len(value) > 200:
                raise ValueError("drafts must contain at most 200 conversations")
            for key, text in value.items():
                if not isinstance(key, str) or not key.startswith(("peer:", "group:")) or len(key) > 160:
                    raise ValueError("Invalid draft conversation")
                if not isinstance(text, str) or len(text.encode()) > 30 * 1024:
                    raise ValueError("Draft exceeds 30 KB")
            await db.set_desktop_drafts(value)
        return {"drafts": await db.get_desktop_drafts()}

    return {"search_messages": search, "history_page": history, "desktop_drafts": drafts}
