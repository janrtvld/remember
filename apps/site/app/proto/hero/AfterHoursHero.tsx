'use client'

import { ArrowRight as IconArrowRight } from 'lucide-react'
import Image from 'next/image'
import { useId, useRef, useState } from 'react'
import { DownloadButton } from '../../../components/DownloadButton'
import './after-hours.css'

const memories = [
  {
    id: 'conversation',
    object: 'amber glass cube',
    label: 'A conversation',
    time: '10:24',
    title: 'The reason behind the decision.',
    text: 'We kept the first version small. One useful answer is better than another dashboard.',
    source: 'Design conversation · Example memory',
  },
  {
    id: 'thought',
    object: 'open notebook',
    label: 'A thought',
    time: '14:08',
    title: 'The idea you almost lost.',
    text: 'What if coming back to work felt like picking up a conversation?',
    source: 'Afternoon note · Example memory',
  },
  {
    id: 'context',
    object: 'laptop',
    label: 'Where you left off',
    time: '18:42',
    title: 'A place to begin tomorrow.',
    text: 'The prototype is ready. Next: walk through the first five minutes with someone new.',
    source: 'Project context · Example memory',
  },
] as const

export function AfterHoursHero() {
  const memoryId = useId()
  const hotspotRefs = useRef<(HTMLButtonElement | null)[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const memory = selected === null ? null : memories[selected]

  function closeMemory() {
    if (selected !== null) hotspotRefs.current[selected]?.focus()
    setSelected(null)
  }

  return (
    <section
      className="after-hours-hero"
      aria-labelledby="after-hours-title"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && selected !== null) closeMemory()
      }}
    >
      <div className="after-hours-scene">
        <Image
          src="/proto/hero/after-hours-studio.png"
          alt=""
          fill
          sizes="(max-width: 820px) 800px, (max-width: 1100px) 1100px, 100vw"
          loading="eager"
          fetchPriority="high"
          className="after-hours-image"
        />
        <div className="after-hours-scene-shade" />
        <div className="after-hours-hotspots" aria-label="Explore three example memories">
          {memories.map((item, index) => (
            <button
              type="button"
              key={item.id}
              ref={(element) => {
                hotspotRefs.current[index] = element
              }}
              className={`after-hours-hotspot after-hours-hotspot-${item.id}`}
              aria-label={`${selected === index ? 'Close' : 'Open'} ${item.label.toLowerCase()} at the ${item.object}`}
              aria-expanded={selected === index}
              aria-controls={memoryId}
              data-selected={selected === index}
              onClick={() => setSelected(selected === index ? null : index)}
            >
              <span className="after-hours-hotspot-mark" aria-hidden="true">
                {selected === index ? '−' : '+'}
              </span>
              <span className="after-hours-hotspot-label">{item.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="after-hours-content">
        <h1 id="after-hours-title">
          <span>Leave the work.</span>
          <span>Keep the thought.</span>
        </h1>
        <p className="after-hours-description">
          Your conversations, decisions, and unfinished ideas. Remember keeps the context ready for when you return.
        </p>
        <div className="after-hours-actions">
          <DownloadButton size="small" className="after-hours-download">
            Download for Mac <IconArrowRight className="size-4" />
          </DownloadButton>
          <a className="after-hours-preview-link" href="#product-preview">
            Meet Remember <span aria-hidden="true">↗</span>
          </a>
        </div>
        <p className="after-hours-availability">In beta for macOS. Works with Codex and Claude.</p>
      </div>

      <div className="after-hours-memory-slot" id={memoryId} aria-live="polite" aria-atomic="true">
        {memory ? (
          <article className="after-hours-memory" key={memory.id}>
            <div className="after-hours-memory-topline">
              <span>{memory.label}</span>
              <time>{memory.time}</time>
              <button
                className="after-hours-memory-close"
                type="button"
                aria-label="Close example memory"
                onClick={closeMemory}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <h2>{memory.title}</h2>
            <p>{memory.text}</p>
            <span className="after-hours-memory-source">{memory.source}</span>
          </article>
        ) : null}
      </div>

      <div className="after-hours-footer">
        <span className="after-hours-explore-hint">
          <span className="after-hours-explore-mark" aria-hidden="true">
            +
          </span>{' '}
          Explore the objects
        </span>
      </div>
    </section>
  )
}
