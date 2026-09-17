-- Contact.visitorId: the identity that outlives the billing session.
--
-- WHY. Contacts are found by Contact.sessionId, and the widget rotates its
-- session id after 30 minutes of idle because that is the billing session rule
-- (spec 15). A shopper who came back an hour later therefore arrived as a new
-- anonymous contact on a new conversation, and the agent lost the name, the
-- ruling number, the budget — everything it had been told. The billing rule is
-- correct and stays; identity just needed its own, longer-lived key.
--
-- Nullable and additive: existing contacts keep matching on sessionId, and a
-- returning browser adopts its visitorId on the next turn.

ALTER TABLE "contacts" ADD COLUMN "visitorId" TEXT;

CREATE INDEX "contacts_shopId_visitorId_idx" ON "contacts"("shopId", "visitorId");
