// Copyright 2022 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Helpers from '../helpers/helpers.js';
import * as Types from '../types/types.js';

const animations: Types.Events.Animation[] = [];
const animationsSyntheticEvents: Types.Events.SyntheticAnimationPair[] = [];
const animationFrames: Array<
                        Types.Events.TraceEventAnimationFrameGroupingEvent |
                        Types.Events.TraceEventAnimationFrameInstantEvent |
                        Types.Events.TraceEventAnimationFramePaintGroupingEvent |
                        Types.Events.TraceEventAnimationFrameScriptGroupingEvent
                        > = [];
const animationFramesSyntheticEvents: Types.Events.SyntheticExtendedAnimationFramePair[] = [];

export interface AnimationData {
  animations: readonly Types.Events.SyntheticAnimationPair[];
  animationFrames: readonly Types.Events.SyntheticExtendedAnimationFramePair[];
}

export function reset(): void {
  animations.length = 0;
  animationsSyntheticEvents.length = 0;
  animationFrames.length = 0;
  animationFramesSyntheticEvents.length = 0;
}

function isAnimationFrameGrouping(event: Types.Events.Event): event is
  Types.Events.TraceEventAnimationFrameGroupingEvent |
  Types.Events.TraceEventAnimationFrameInstantEvent |
  Types.Events.TraceEventAnimationFramePaintGroupingEvent |
  Types.Events.TraceEventAnimationFrameScriptGroupingEvent {
  return Types.Events.isTraceEventAnimationFrame(event) ||
    Types.Events.isTraceEventAnimationFramePaint(event) ||
    Types.Events.isTraceEventAnimationFrameScript(event) ||
    Types.Events.isTraceEventAnimationFrameInstant(event);
}
const eventSulfixes: string[] = [];
let currentGroupingEventSulfix: string | null = null;

export function handleEvent(event: Types.Events.Event): void {
  if (Types.Events.isAnimation(event)) {
    animations.push(event);
    return;
  }

   if (isAnimationFrameGrouping(event)) {
    // INFO: Hack to correctly pair AnimationFrame nestable groupings. Since the current
    // local id is not correctly set.
    const isStartEvent = event.ph === Types.Events.Phase.ASYNC_NESTABLE_START;
    const isEndEvent = event.ph === Types.Events.Phase.ASYNC_NESTABLE_END;
    const isInstant = event.ph === Types.Events.Phase.ASYNC_NESTABLE_INSTANT;

    if (isStartEvent && event.name === Types.Events.Name.ANIMATION_FRAME) {
      currentGroupingEventSulfix = `${event.ts}`;
    }

    // INFO: Add a sulfix to each event to correctly pair AnimationFrame nestable groupings.
    // Since we can have multiple script and instant entries in the same animation frame.
    if (isStartEvent && event.name !== Types.Events.Name.ANIMATION_FRAME) {
      const currentBeginEventSulfix = `${event.ts}`;
      eventSulfixes.push(currentBeginEventSulfix);
    }

    if (event.name === Types.Events.Name.ANIMATION_FRAME) {
      event.id2 = { local: `${event.id2?.local}-${currentGroupingEventSulfix}` };
    } else {
      // INFO: Hack to correctly pair AnimationFrame nestable groupings. Since the current
      // Has to be unique for each event but correclty match the begining and end events to form
      // the pairs.
      let currentBeginEventSulfix = isEndEvent ? eventSulfixes.pop() : eventSulfixes.at(-1);
      currentBeginEventSulfix = isInstant ? `${event.ts}` : currentBeginEventSulfix;
      event.id2 = { local: `${event.id2?.local}-${currentGroupingEventSulfix}-${currentBeginEventSulfix}` };
    }

    animationFrames.push(event);

    return;
  }
}

export async function finalize(): Promise<void> {
  const syntheticEvents = Helpers.Trace.createMatchedSortedSyntheticEvents(animations);
  animationsSyntheticEvents.push(...syntheticEvents);

  const afSyntheticEvents = Helpers.Trace.createMatchedSortedSyntheticEvents(animationFrames) as Types.Events.SyntheticExtendedAnimationFramePair[];
  animationFramesSyntheticEvents.push(...afSyntheticEvents);
}

export function data(): AnimationData {
  return {
    animations: animationsSyntheticEvents,
    animationFrames: animationFramesSyntheticEvents,
  };
}
