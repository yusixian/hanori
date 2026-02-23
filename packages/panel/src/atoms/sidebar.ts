import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export const sidebarOpenAtom = atom(false);

export const sidebarCollapsedAtom = atomWithStorage("sidebar-collapsed", false);
