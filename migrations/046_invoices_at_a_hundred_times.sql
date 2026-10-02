-- Wire was asked for every invoice ×100 (a 400,000₮ order showed as a
-- 40,000,000₮ QPay invoice) until the deploy this runs in. None of those can
-- be the one a person pays: every top-up still waiting at this moment is let
-- go, so the next press raises a fresh invoice at the right amount. Wire lets
-- its intents go after about ten minutes on its own; one paid all the same is
-- still found by the scheduler's hour of re-checks and lands in the wallet.
UPDATE ledger.topup
   SET state = 'expired'
 WHERE state = 'pending'
   AND provider = 'qpay'
   AND provider_ref IS NOT NULL
   AND provider_ref LIKE 'pi\_%';
