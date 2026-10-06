<script setup lang="ts">
import { CAMERAS, CLUSTER, ICON, LABEL_OFFSET, SECTOR, START_VIEW, recordClicks } from './scene'

const camera = { position: START_VIEW, heading: 0, pitch: -90, roll: 0 }

const onReady = ({ Cesium, viewer }: { Cesium: unknown; viewer: unknown }) => recordClicks(Cesium, viewer)
</script>

<template>
  <vc-viewer :camera="camera" :infoBox="false" @ready="onReady">
    <vc-entity v-for="cam in CAMERAS" :key="cam.name" :id="cam.id" :position="cam">
      <vc-graphics-billboard :image="ICON" />
      <vc-graphics-label :text="cam.name" :pixel-offset="LABEL_OFFSET" font="14px sans-serif" />
    </vc-entity>
    <vc-entity>
      <vc-graphics-polygon :hierarchy="SECTOR" :material="'rgba(255,193,7,0.4)'" />
    </vc-entity>
    <vc-datasource-custom name="clusters">
      <vc-entity :id="CLUSTER.id" :position="CLUSTER">
        <vc-graphics-billboard :image="ICON" />
      </vc-entity>
    </vc-datasource-custom>
  </vc-viewer>
</template>
