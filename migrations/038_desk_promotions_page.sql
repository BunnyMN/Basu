-- ── The desk's page of listings put first ────────────────────────────
--
-- A new desk page, «Онцлох зар», and the permission to take a promotion off.
-- Built-in roles get it from the code on a fresh server; on one that already
-- has its roles, whoever reads suppliers may read promotions, and whoever may
-- manage suppliers may take a promotion off.
UPDATE access.role
   SET permissions = array_append(permissions, 'desk.promotions')
 WHERE scope = 'desk' AND 'desk.suppliers' = ANY (permissions)
   AND NOT ('desk.promotions' = ANY (permissions));
UPDATE access.role
   SET permissions = array_append(permissions, 'desk.promotions:manage')
 WHERE scope = 'desk' AND 'desk.suppliers:manage' = ANY (permissions)
   AND NOT ('desk.promotions:manage' = ANY (permissions));
