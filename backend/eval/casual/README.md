# Hand-written casual group chats

Twenty short group chats written for this project, each with two to four conversations
interleaved the way they are in a real friends' group: short replies, reactions,
questions answered several messages later, and about a third in mixed Hindi/English.

Format, one message per line:

    +<seconds since the previous message> <speaker> <TOPIC> <text>

`TOPIC` is the ground-truth label: the conversation a person reading the chat would
say the message belongs to. Lines starting with `#` are metadata or comments.

`dev-*.txt` (15 chats, 603 messages) are used to fit and tune the assigner's weights.
`test-*.txt` (5 chats, 207 messages) are held out: they were written before any
tuning, and while developing the assigner only their aggregate scores were looked
at, never which of their messages it got wrong.

These are synthetic: they were written by the author of the assigner, so they are an
easier and friendlier test than real chats. Treat results on them as an upper bound.
