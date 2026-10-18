import { ImageResponse } from 'next/og';

export const alt = 'EURO TERANGA — autocar Paris ↔ Dakar';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/** Twitter/X card image: same content as the Open Graph image. */
export default function TwitterImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: '72px 80px',
        background: 'linear-gradient(135deg, #073b31 0%, #0b5d4b 60%, #13705b 100%)',
        color: '#fffdf7',
        fontFamily: 'sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 24, fontSize: 40 }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 18,
            background: '#f4bf50',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#073b31',
            fontSize: 40,
            fontWeight: 800,
          }}
        >
          ET
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <span>EURO</span>
          <span style={{ fontWeight: 800 }}>TERANGA</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ fontSize: 84, fontWeight: 800, lineHeight: 1.05 }}>Paris ↔ Dakar</div>
        <div style={{ fontSize: 36, color: '#e8f5ef', maxWidth: 900 }}>
          L’autocar qui relie l’Europe et l’Afrique : réservation en ligne, siège choisi, trajet
          suivi.
        </div>
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 28, color: '#f4bf50' }}>
        <span>France</span>
        <span>·</span>
        <span>Espagne</span>
        <span>·</span>
        <span>Maroc</span>
        <span>·</span>
        <span>Mauritanie</span>
        <span>·</span>
        <span>Sénégal</span>
      </div>
    </div>,
    size,
  );
}
