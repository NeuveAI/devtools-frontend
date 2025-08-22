// Copyright 2025 The Chromium Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

import * as Trace from '../../models/trace/trace.js';
import * as TimelineUtils from '../../panels/timeline/utils/utils.js';

type InsightResponse = {
  focus: TimelineUtils.AIContext.AgentFocus,
}|{error: string};

type CallTreeResponse = {
  focus: TimelineUtils.AIContext.AgentFocus,
}|{error: string};

/**
 * For an external request, get the insight to debug based on its user visible title.
 * Currently, this function makes some assumptions that in time we will need to
 * avoid:
 * - It assumes a trace exists that had one or zero navigations. It is unable
 *   to figure out which insight to use if there are >1 navigations -it would need
 *   some extra input data to figure it out.
 */
export async function getInsightAgentFocusToDebug(
    model: Trace.TraceModel.Model, insightTitle: string): Promise<InsightResponse> {
  const parsedTrace = model.parsedTrace();
  const latestInsights = model.traceInsights();
  if (!latestInsights || !parsedTrace) {
    return {
      error: 'No trace has been recorded, so we cannot analyze any insights',
    };
  }

  // Right now we only support the basic Reload & Record flow and assume
  // there is always one navigation. Longer term we need a more robust way
  // for the request to specify which navigation it's interested in.
  const firstNavigation = Array.from(latestInsights.keys()).find(k => k !== Trace.Types.Events.NO_NAVIGATION);
  const insights =
      firstNavigation ? latestInsights.get(firstNavigation) : latestInsights.get(Trace.Types.Events.NO_NAVIGATION);
  if (!insights) {
    return {
      error: 'Could not find any navigation with insights.',
    };
  }

  const insightKeys = Object.keys(insights.model) as Array<keyof Trace.Insights.Types.InsightModels>;
  const matchingInsightKey = insightKeys.find(insightKey => {
    const insight = insights.model[insightKey];
    return insight.title === insightTitle;
  });
  if (!matchingInsightKey) {
    return {
      error: `Could not find matching insight for ${insightTitle}`,
    };
  }

  const insight = insights.model[matchingInsightKey];
  const focus = TimelineUtils.AIContext.AgentFocus.fromInsight(parsedTrace, insight, insights.bounds);
  return {focus};
}

export const enum CallTreeSearchType {
  LONGEST_ANIMATION_FRAME = 'longest_animation_frame',
  INP_INTERACTION = 'inp_interaction',
}

export async function getCallTreeAgentFocusToDebug(
    model: Trace.TraceModel.Model, searchType: CallTreeSearchType): Promise<CallTreeResponse> {
  const parsedTrace = model.parsedTrace();
  if (!parsedTrace) {
    return {
      error: 'No trace has been recorded, so we cannot analyze any insights',
    };
  }

  let event: Trace.Types.Events.Event|null = null;

  switch (searchType) {
    case CallTreeSearchType.LONGEST_ANIMATION_FRAME: {
      event = parsedTrace.AnimationFrames.animationFrames.sort((a, b) => {
        return b.dur - a.dur;
      })[0];
      break;
    }
    case CallTreeSearchType.INP_INTERACTION: {
      event = parsedTrace.UserInteractions.longestInteractionEvent;
      break;
    }
  }

  if (!event) {
    return {
      error: `Could not find any event to debug for ${searchType}`,
    };
  }

  const callTree = TimelineUtils.AICallTree.AICallTree.fromTimeOnThread({
    thread: {
      pid: event.pid,
      tid: event.tid,
    },
    bounds: {
      min: event.ts,
      max: Trace.Types.Timing.Micro(event.ts + (event.dur ?? 0)),
      range: Trace.Types.Timing.Micro(event.ts + (event.dur ?? 0)),
    },
    parsedTrace,
  });

  if (!callTree) {
    return {
      error: 'Could not find any call tree for the longest animation frame',
    };
  }

  const focus = TimelineUtils.AIContext.AgentFocus.fromCallTree(callTree);
  return {focus};
}
