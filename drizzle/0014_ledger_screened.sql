-- Mail that a reading set aside before the ledger recorded it. Say so, so it can be found and brought back.
UPDATE "mail_ledger" AS l
SET "disposition" = 'screened', "reason" = CASE WHEN m."is_spam" THEN 'Looks like spam.' ELSE 'Looks like a mailing list or automatic mail.' END
FROM "email_messages" AS m
WHERE m."id" = l."message_id" AND l."disposition" = 'filed' AND l."restored_at" IS NULL AND m."triage_status" = 'archived' AND (m."is_automated" OR m."is_spam");
