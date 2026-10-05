// The one entry point bundled into extensions/flow/vendor/xyflow.js. It exposes what the
// view uses as window.FlowKit, so the view's own code stays plain, readable JavaScript.
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, MarkerType,
  applyNodeChanges, applyEdgeChanges, useReactFlow,
} from '@xyflow/react';

window.FlowKit = {
  React, createRoot,
  ReactFlow, ReactFlowProvider, Background, Controls, Handle, Position, MarkerType,
  applyNodeChanges, applyEdgeChanges, useReactFlow,
};
