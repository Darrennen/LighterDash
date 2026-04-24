"""Simple in-memory per-IP sliding-window rate limiter (no external deps)."""
from __future__ import annotations

import time
from collections import defaultdict


class RateLimiter:
    """Allow at most `max_calls` per `window_secs` per key (usually client IP)."""

    def __init__(self, max_calls: int, window_secs: int) -> None:
        self.max_calls = max_calls
        self.window = window_secs
        self._log: dict[str, list[float]] = defaultdict(list)

    def is_allowed(self, key: str) -> bool:
        now = time.time()
        cutoff = now - self.window
        calls = self._log[key]
        # drop timestamps outside the current window
        self._log[key] = [t for t in calls if t > cutoff]
        if len(self._log[key]) >= self.max_calls:
            return False
        self._log[key].append(now)
        return True

    def cleanup(self) -> None:
        """Remove keys with no recent calls (call periodically to avoid memory growth)."""
        cutoff = time.time() - self.window
        dead = [k for k, v in self._log.items() if not any(t > cutoff for t in v)]
        for k in dead:
            del self._log[k]


# Shared instances — tuned conservatively for a public endpoint
explorer_limiter  = RateLimiter(max_calls=20, window_secs=60)   # 20 account lookups / IP / min
staking_limiter   = RateLimiter(max_calls=5,  window_secs=60)   # 5 staking-activity / IP / min
