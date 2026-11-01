-- Operations administrators and district officers act as themselves in the audit trail (D84).


ALTER TYPE "ActorType" ADD VALUE 'OPS_ADMIN';
ALTER TYPE "ActorType" ADD VALUE 'DISTRICT';

