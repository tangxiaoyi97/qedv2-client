/**
 * Asset resolution plumbing. Figure `src` values are bank-root-relative
 * paths; the shell decides where assets come from (remote core, local core,
 * cache). Components resolve through this injection so @qed2/ui stays
 * platform-free.
 */
import { inject, provide, type InjectionKey } from 'vue';

export type AssetResolver = (src: string) => string;

const KEY: InjectionKey<AssetResolver> = Symbol('qed2-asset-resolver');

export function provideAssetResolver(resolver: AssetResolver): void {
  provide(KEY, resolver);
}

export function useAssetResolver(): AssetResolver {
  return inject(KEY, (src: string) => src);
}
