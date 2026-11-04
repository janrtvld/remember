'use client'

import { Pause as IconPause, Play as IconPlay } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { type SiteLocale, siteText } from '../../lib/locale-shared'

export function FeatureVideo({
  locale,
  src,
  poster,
  width,
  height,
}: {
  locale: SiteLocale
  src: string
  poster: string
  width: number
  height: number
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [loaded, setLoaded] = useState(false)
  const [inView, setInView] = useState(false)
  const [tabVisible, setTabVisible] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(true)
  const [manualPlayback, setManualPlayback] = useState<boolean | null>(null)
  const [playing, setPlaying] = useState(false)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let sourceAttached = false

    function updateMotion() {
      setReducedMotion(motion.matches)
      if (motion.matches) setManualPlayback((current) => (current === true ? null : current))
    }
    function updateVisibility() {
      setTabVisible(!document.hidden)
    }

    updateMotion()
    updateVisibility()
    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = entry.isIntersecting && entry.intersectionRatio > 0
        setInView(visible)
        if (visible && !sourceAttached) {
          sourceAttached = true
          setLoaded(true)
        }
      },
      { threshold: 0.01, rootMargin: '-72px 0px 0px 0px' }
    )
    observer.observe(video)
    motion.addEventListener('change', updateMotion)
    document.addEventListener('visibilitychange', updateVisibility)
    return () => {
      observer.disconnect()
      motion.removeEventListener('change', updateMotion)
      document.removeEventListener('visibilitychange', updateVisibility)
      video.pause()
    }
  }, [])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (!loaded || !inView || !tabVisible || !(manualPlayback ?? !reducedMotion)) {
      video.pause()
      return
    }
    if (!video.paused) return
    let cancelled = false
    void video.play().catch(() => {
      if (!cancelled) setPlaying(!video.paused)
    })
    return () => {
      cancelled = true
    }
  }, [loaded, inView, tabVisible, reducedMotion, manualPlayback])

  function togglePlayback() {
    const video = videoRef.current
    if (!video) return
    if (!video.paused) {
      setManualPlayback(false)
      video.pause()
    } else {
      setManualPlayback(true)
      if (inView && tabVisible) void video.play().catch(() => setPlaying(!video.paused))
    }
  }

  return (
    <div className="feature-video" style={{ aspectRatio: `${width} / ${height}` }}>
      <video
        ref={videoRef}
        className="feature-video-element"
        src={loaded ? src : undefined}
        poster={poster}
        width={width}
        height={height}
        preload="none"
        muted
        playsInline
        loop
        aria-label={siteText(locale, 'Productvoorbeeld van Remember', 'Remember product preview')}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => setPlaying(false)}
      />
      {loaded ? (
        <button
          type="button"
          className="feature-video-toggle"
          onClick={togglePlayback}
          aria-label={
            playing
              ? siteText(locale, 'Productvideo pauzeren', 'Pause product video')
              : siteText(locale, 'Productvideo afspelen', 'Play product video')
          }
        >
          {playing ? <IconPause aria-hidden="true" /> : <IconPlay aria-hidden="true" />}
        </button>
      ) : null}
    </div>
  )
}
