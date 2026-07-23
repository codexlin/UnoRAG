from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from qdrant_client.http import models as qm

from app.security.internal_context import RequestContext
from app.settings import Settings

AclScope = Literal["workspace", "restricted"]


@dataclass(frozen=True)
class AccessScope:
	tenant_id: str
	workspace_id: str
	principal_id: str
	group_ids: tuple[str, ...] = ()

	@classmethod
	def from_request_context(cls, context: RequestContext) -> "AccessScope":
		return cls(
			tenant_id=context.tenant_id,
			workspace_id=context.workspace_id,
			principal_id=context.principal_id,
			group_ids=context.group_ids,
		)

	@classmethod
	def development(cls, settings: Settings) -> "AccessScope":
		return cls(
			tenant_id=settings.default_tenant_id,
			workspace_id=settings.default_workspace_id,
			principal_id="development",
		)

	def cache_key(self) -> str:
		groups = ",".join(sorted(self.group_ids))
		return f"{self.tenant_id}:{self.workspace_id}:{self.principal_id}:{groups}"

	def payload(
		self,
		*,
		acl_scope: AclScope = "workspace",
		allowed_principal_ids: tuple[str, ...] = (),
		allowed_group_ids: tuple[str, ...] = (),
	) -> dict[str, object]:
		principals = tuple(dict.fromkeys((self.principal_id, *allowed_principal_ids)))
		return {
			"tenant_id": self.tenant_id,
			"workspace_id": self.workspace_id,
			"acl_scope": acl_scope,
			"acl_principal_ids": list(principals),
			"acl_group_ids": list(dict.fromkeys(allowed_group_ids)),
		}

	def qdrant_conditions(self) -> list[qm.Condition]:
		visibility: list[qm.Condition] = [
			qm.FieldCondition(
				key="acl_scope",
				match=qm.MatchValue(value="workspace"),
			),
			qm.FieldCondition(
				key="acl_principal_ids",
				match=qm.MatchAny(any=[self.principal_id]),
			),
		]
		if self.group_ids:
			visibility.append(
				qm.FieldCondition(
					key="acl_group_ids",
					match=qm.MatchAny(any=list(self.group_ids)),
				)
			)
		return [
			qm.FieldCondition(
				key="tenant_id",
				match=qm.MatchValue(value=self.tenant_id),
			),
			qm.FieldCondition(
				key="workspace_id",
				match=qm.MatchValue(value=self.workspace_id),
			),
			qm.Filter(should=visibility),
		]


def resolve_access_scope(
	settings: Settings,
	scope: AccessScope | None,
) -> AccessScope:
	if scope is not None:
		return scope
	if settings.internal_auth_enabled:
		raise ValueError("authenticated access scope is required")
	return AccessScope.development(settings)
