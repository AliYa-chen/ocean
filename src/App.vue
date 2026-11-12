<script setup lang="ts">
import WaterScene from '@/components/water/WaterScene.vue'
</script>

<template>
  <main class="ocean-app">
    <WaterScene />
  </main>
</template>

<style scoped>
.ocean-app {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #183b4e;
}
</style>
