export interface BrandMarkProps {
  /** Application name shown next to the brand, e.g. "Booking". */
  product?: string;
}

/** Text-only brand mark. A definitive logo will replace it later. */
export function BrandMark({ product }: BrandMarkProps) {
  return (
    <span className="et-brand">
      <span className="et-brand__name">EURO TERANGA</span>
      {product ? <span className="et-brand__product">{product}</span> : null}
    </span>
  );
}
