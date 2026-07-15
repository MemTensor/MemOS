import type {
  ClientModeConfig as RootClientModeConfig,
  HubModeConfig as RootHubModeConfig,
  SharingCapabilities as RootSharingCapabilities,
  SharingConfig as RootSharingConfig,
  SharingRole as RootSharingRole,
} from "../types";
import type {
  ClientModeConfig as SharingClientModeConfig,
  GroupInfo,
  HubModeConfig as SharingHubModeConfig,
  HubSearchHit,
  NetworkSearchResult,
  SharingCapabilities as SharingSharingCapabilities,
  SharingConfig as SharingSharingConfig,
  SharingRole as SharingSharingRole,
  SkillBundle,
  UserInfo,
} from "./types";

type Assert<T extends true> = T;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? ((<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2) ? true : false)
    : false;
type Extends<A, B> = A extends B ? true : false;

type _SharingRoleMatchesRoot = Assert<Equal<SharingSharingRole, RootSharingRole>>;
type _SharingCapabilitiesMatchRoot = Assert<Equal<SharingSharingCapabilities, RootSharingCapabilities>>;
type _HubModeConfigMatchesRoot = Assert<Equal<SharingHubModeConfig, RootHubModeConfig>>;
type _ClientModeConfigMatchesRoot = Assert<Equal<SharingClientModeConfig, RootClientModeConfig>>;
type _SharingConfigMatchesRoot = Assert<Equal<SharingSharingConfig, RootSharingConfig>>;

type _GroupInfoExists = Assert<Extends<GroupInfo, { id: string; name: string }>>;
type _UserInfoExists = Assert<Extends<UserInfo, { id: string; username: string }>>;
type _HubSearchHitExists = Assert<Extends<HubSearchHit, { remoteHitId: string; hubRank: number }>>;
type _NetworkSearchResultExists = Assert<Extends<NetworkSearchResult, { local: unknown; hub: unknown }>>;
type _SkillBundleExists = Assert<Extends<SkillBundle, { metadata: unknown; bundle: unknown }>>;

export {};
