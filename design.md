# Design System Requirements

## Intent

We want a small, framework-agnostic design system for the Frieren host app and the apps running inside it.

The host app is `apps/frieren`. It is the operating-system layer. Inner apps are the applications that live within that environment. The design system should serve both sides: the host needs OS-level interface elements, while inner apps need application-level controls and layout primitives.

The goal is not to create a website UI kit. The goal is to support an operating-system-like shell and small application interfaces that feel closer to desktop software: compact, capable, structured, and comfortable for repeated use.

The reference taste is closer to OS X Snow Leopard-era desktop applications than to modern SaaS pages. This means the system should support app-like surfaces, menus, controls, panes, dialogs, and dense workflows without pushing authors toward landing-page composition or card-heavy web aesthetics.

That reference is about taste and structure, not literal platform constraints. Classic OS X was not designed for touch, but Frieren should be perfectly workable on an iPad. The design system should preserve a desktop-app feeling while still supporting comfortable touch targets, touch scrolling, coarse pointers, and layouts that can adapt when precision mouse input is unavailable.

## Context

The host app is React, but inner apps should not be required to use React. Inner apps may be written with React, another framework, or no framework at all.

Because of that, the design system should not depend on React components as its primary contract. A React-only solution would make it hard for non-React apps to participate and would make style sharing across app boundaries fragile.

We also do not want to make shadcn the shared design system. shadcn is excellent inside React apps, but it is tied to the React ecosystem and source-copy component ownership. That does not match the shape of our app platform.

Pure Tailwind CSS is a useful primitive, but by itself it leaves too much repeated design work to every app author. We want a shared layer above Tailwind that gives app authors a common visual language while staying flexible.

## Requirements

The design system should be:

- framework-agnostic
- easy for small inner apps to adopt
- usable from plain HTML/CSS
- compatible with Tailwind CSS
- compact and desktop-app oriented
- workable on touch devices such as iPad
- incremental rather than comprehensive up front
- flexible enough for apps with distinct personalities
- minimal in API surface
- stable enough that app authors can depend on it

It should help the host provide common operating-system interface patterns such as:

- a menubar
- app icons
- system/app command surfaces
- app launching and switching affordances, kept minimal for now
- shared shell surfaces around inner apps

It should help app authors build common desktop-app interface patterns such as:

- command areas
- menus
- buttons
- text inputs
- dialogs
- bordered or grouped regions
- panes and app surfaces
- simple control groupings

This document does not define the concrete component API, class names, token names, spacing scale, color palette, or visual treatment. Those decisions should be made later, when implementing against real app screens.

## Taste

The desired taste is restrained and utilitarian.

Interfaces should feel like tools and system software rather than pages. The design language should make it natural to build the host shell itself, plus things like editors, inspectors, file browsers, preferences windows, launchers, utilities, and small productivity apps.

The system should avoid assumptions common in web-page UI kits, such as large vertical spacing, marketing-style cards, oversized controls, prominent decorative gradients, or page-section composition. It should instead support compact controls, clear hierarchy, subtle separation, and durable interaction states.

Compact should not mean hostile to touch. The design should be able to offer enough target size and spacing for iPad use without losing the feeling of a desktop application. Mouse, keyboard, and touch should all be treated as first-class input modes.

The design should be capable of looking polished, but polish should come from careful proportion, alignment, state handling, and consistency rather than ornament.

The system should also be themeable across drastically different aesthetics. A useful test is whether the same design system could support a theme inspired by Blizzard-style game interfaces, such as Warcraft or StarCraft, without the result feeling awkward or forced. The underlying structure should be stable enough for desktop utility UI, but expressive enough that a theme can radically change mood, material, and atmosphere while keeping implementation natural.

## General Technical Direction

The shared foundation should be CSS-based rather than component-runtime-based.

The likely direction is:

- design tokens expressed as CSS variables
- Tailwind CSS integration for authors who want utility-class composition
- framework-neutral styling primitives that can be used from any inner app

This direction keeps the design system close to the browser platform and avoids locking inner apps to the host app's React stack.

Tokens give us a shared semantic contract for theme, surface, typography, state, and other visual concerns without requiring all apps to consume the same JavaScript framework. Tailwind gives app authors a productive way to compose custom interfaces while still drawing from the shared system.

The token model should leave room for themes that differ by more than color. It should be possible for a theme to change the perceived material, density, shape language, borders, depth, typography, and interaction feel without fighting the system.

The design system should not try to solve every UI need immediately. It should start with the smallest useful foundation, then grow only when real apps need new patterns.

## Non-Goals

This is not a complete component library spec.

This is not a visual design specification.

This is not a shadcn replacement in the React-component sense.

This is not a web-page theme.

This is not a commitment to a specific token list, class naming scheme, component implementation, or interaction library.

This is not a commitment to decorative OS metaphors such as a dock, desktop wallpaper system, window chrome, or other shell features before they are needed.

## Guiding Principle

Prefer a small, durable shared language over a large generic UI kit.

The shared language should describe intent and role more than appearance, so themes can move between restrained operating-system UI and highly stylized game-like UI without rewriting app code.

Add design-system surface area only when an actual app needs it.
