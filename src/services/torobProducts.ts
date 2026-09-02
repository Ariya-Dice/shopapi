import { createClient } from '@supabase/supabase-js';
import { createPublicKey, verify } from 'node:crypto';
import type { Request } from 'express';

const TOROB_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAt6Mu4T0pBORY11W+QeM35UsmLO3vsf+6yKpFDEImFk0=
-----END PUBLIC KEY-----`;

const PAGE_SIZE = 100;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for Torob API',
  );
}

const supabase = createClient(
  supabaseUrl,
  supabaseServiceRoleKey,
  {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  },
);

type TorobRequest =
  | {
      page_urls: string[];
      page_uniques?: never;
      page?: never;
      sort?: never;
    }
  | {
      page_uniques: string[];
      page_urls?: never;
      page?: never;
      sort?: never;
    }
  | {
      page: number;
      sort: 'date_added_desc';
      page_urls?: never;
      page_uniques?: never;
    };

interface ProductRow {
  id: number;
  model: string;
  type: string;
  goods_type: string;
  color: string;
  body_material: string | null;
  handle_material: string | null;
  body_weight: string;
  package_weight: string | null;
  cartridge_size: string | null;
  cartridge_nut_material: string | null;
  left_handed_nut: string | null;
  hot_cold_output: string | null;
  package_dimensions: string | null;
  postal_hose: string | null;
  escutcheon: string | null;
  valve_material: string | null;
  spout_material: string | null;
  plator_material: string | null;
  hose_material: string | null;
  tags: string[];
  price: number;
  description: string;
  image: string;
  created_at: string;
  brand: string;
  stock: number;
}

interface TorobProduct {
  page_unique: string;
  page_url: string;
  product_group_id?: string;
  title: string;
  subtitle?: string;
  current_price: number;
  old_price?: number;
  availability: boolean;
  category_name?: string;
  image_links: string[];
  spec: Record<string, string>;
  short_desc?: string;
  date_added: string;
}

function base64UrlToBuffer(value: string): Buffer {
  const normalized = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');

  return Buffer.from(normalized, 'base64');
}

function parseJwt(token: string) {
  const parts = token.split('.');

  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }

  const [
    encodedHeader,
    encodedPayload,
    encodedSignature,
  ] = parts;

  const header = JSON.parse(
    base64UrlToBuffer(encodedHeader).toString('utf8'),
  );

  const payload = JSON.parse(
    base64UrlToBuffer(encodedPayload).toString('utf8'),
  );

  const signature = base64UrlToBuffer(encodedSignature);

  return {
    encodedHeader,
    encodedPayload,
    signature,
    header,
    payload,
  };
}

function validateTorobJwt(req: Request): void {
  const token = req.header('X-Torob-Token');
  const tokenVersion = req.header('X-Torob-Token-Version');

  if (!token) {
    throw new TorobAuthError(
      'Torob token is missing',
      401,
    );
  }

  if (tokenVersion !== '1') {
    throw new TorobAuthError(
      'Invalid Torob token version',
      401,
    );
  }

  const {
    encodedHeader,
    encodedPayload,
    signature,
    header,
    payload,
  } = parseJwt(token);

  if (header.alg !== 'EdDSA') {
    throw new TorobAuthError(
      'Invalid JWT algorithm',
      401,
    );
  }

  const signingInput = Buffer.from(
    `${encodedHeader}.${encodedPayload}`,
    'utf8',
  );

  const publicKey = createPublicKey({
    key: TOROB_PUBLIC_KEY,
    format: 'pem',
    type: 'spki',
  });

  const isValidSignature = verify(
    null,
    signingInput,
    publicKey,
    signature,
  );

  if (!isValidSignature) {
    throw new TorobAuthError(
      'Invalid JWT signature',
      401,
    );
  }

  const now = Math.floor(Date.now() / 1000);

  if (
    typeof payload.exp !== 'number' ||
    now >= payload.exp
  ) {
    throw new TorobAuthError(
      'JWT has expired',
      401,
    );
  }

  if (
    payload.nbf !== undefined &&
    (
      typeof payload.nbf !== 'number' ||
      now < payload.nbf
    )
  ) {
    throw new TorobAuthError(
      'JWT is not active yet',
      401,
    );
  }

  const requestHost = req.get('host');

  if (!requestHost) {
    throw new TorobAuthError(
      'Request host is missing',
      401,
    );
  }

  if (payload.aud !== requestHost) {
    throw new TorobAuthError(
      'JWT audience does not match request host',
      401,
    );
  }
}

export class TorobAuthError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 401) {
    super(message);
    this.name = 'TorobAuthError';
    this.statusCode = statusCode;
  }
}

export class TorobValidationError extends Error {
  statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = 'TorobValidationError';
    this.statusCode = statusCode;
  }
}

function validateRequestBody(
  body: unknown,
): TorobRequest {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body)
  ) {
    throw new TorobValidationError(
      'Invalid request body',
    );
  }

  const value = body as Record<string, unknown>;

  const hasPageUrls =
    Object.prototype.hasOwnProperty.call(
      value,
      'page_urls',
    );

  const hasPageUniques =
    Object.prototype.hasOwnProperty.call(
      value,
      'page_uniques',
    );

  const hasPage =
    Object.prototype.hasOwnProperty.call(
      value,
      'page',
    );

  if (hasPageUrls) {
    if (
      !Array.isArray(value.page_urls) ||
      value.page_urls.length === 0
    ) {
      throw new TorobValidationError(
        'page_urls must be a non-empty array',
      );
    }

    if (
      !value.page_urls.every(
        (item) =>
          typeof item === 'string' &&
          item.length <= 1500,
      )
    ) {
      throw new TorobValidationError(
        'Invalid page_urls',
      );
    }

    return {
      page_urls: value.page_urls as string[],
    };
  }

  if (hasPageUniques) {
    if (
      !Array.isArray(value.page_uniques) ||
      value.page_uniques.length === 0
    ) {
      throw new TorobValidationError(
        'page_uniques must be a non-empty array',
      );
    }

    if (
      !value.page_uniques.every(
        (item) =>
          typeof item === 'string' &&
          item.length > 0 &&
          item.length <= 200,
      )
    ) {
      throw new TorobValidationError(
        'Invalid page_uniques',
      );
    }

    return {
      page_uniques:
        value.page_uniques as string[],
    };
  }

  if (hasPage) {
    if (
      typeof value.page !== 'number' ||
      !Number.isInteger(value.page)
    ) {
      throw new TorobValidationError(
        'page must be an integer',
      );
    }

    if (value.page < 1) {
      throw new TorobValidationError(
        'page must be greater than or equal to 1',
      );
    }

    if (typeof value.sort !== 'string') {
      throw new TorobValidationError(
        'sort parameter is not provided',
      );
    }

    if (value.sort !== 'date_added_desc') {
      throw new TorobValidationError(
        'Unsupported sort parameter',
      );
    }

    return {
      page: value.page,
      sort: 'date_added_desc',
    };
  }

  throw new TorobValidationError(
    'Invalid request parameters',
  );
}

function getShopDomain(): string {
  const configured =
    process.env.TOROB_SHOP_DOMAIN ||
    'https://www.rbshop.ir';

  return configured.replace(/\/+$/, '');
}

function buildProductUrl(id: number): string {
  return `${getShopDomain()}/#/product/${id}`;
}

function addSpec(
  spec: Record<string, string>,
  key: string,
  value: string | null | undefined,
): void {
  if (
    typeof value === 'string' &&
    value.trim()
  ) {
    spec[key] = value.trim();
  }
}

function mapProduct(
  product: ProductRow,
): TorobProduct {
  const spec: Record<string, string> = {};

  addSpec(spec, 'رنگ', product.color);
  addSpec(
    spec,
    'جنس بدنه',
    product.body_material,
  );
  addSpec(
    spec,
    'جنس دسته',
    product.handle_material,
  );
  addSpec(
    spec,
    'وزن بدنه',
    product.body_weight,
  );
  addSpec(
    spec,
    'وزن بسته‌بندی',
    product.package_weight,
  );
  addSpec(
    spec,
    'سایز کارتریج',
    product.cartridge_size,
  );
  addSpec(
    spec,
    'جنس مهره کارتریج',
    product.cartridge_nut_material,
  );
  addSpec(
    spec,
    'مهره چپ‌گرد',
    product.left_handed_nut,
  );
  addSpec(
    spec,
    'خروجی آب گرم و سرد',
    product.hot_cold_output,
  );
  addSpec(
    spec,
    'ابعاد بسته‌بندی',
    product.package_dimensions,
  );
  addSpec(
    spec,
    'شلنگ رابط',
    product.postal_hose,
  );
  addSpec(
    spec,
    'اکسنتریک',
    product.escutcheon,
  );
  addSpec(
    spec,
    'جنس مغزی',
    product.valve_material,
  );
  addSpec(
    spec,
    'جنس آبریز',
    product.spout_material,
  );
  addSpec(
    spec,
    'جنس پلاتور',
    product.plator_material,
  );
  addSpec(
    spec,
    'جنس شلنگ',
    product.hose_material,
  );

  if (
    Array.isArray(product.tags) &&
    product.tags.length > 0
  ) {
    addSpec(
      spec,
      'برچسب‌ها',
      product.tags.join('، '),
    );
  }

  const titleParts = [
    product.brand,
    product.model,
    product.type,
  ].filter(
    (value) =>
      typeof value === 'string' &&
      value.trim(),
  );

  const title =
    titleParts.join(' ').trim() ||
    product.model ||
    `Product ${product.id}`;

  const result: TorobProduct = {
    page_unique: String(product.id),
    page_url: buildProductUrl(product.id),
    product_group_id:
      product.model || String(product.id),
    title: title.slice(0, 500),
    current_price:
      Number.isInteger(product.price) &&
      product.price >= 0
        ? product.price
        : 0,
    availability:
      Number.isFinite(product.stock) &&
      product.stock > 0,
    image_links: [],
    spec,
    date_added:
      new Date(
        product.created_at,
      ).toISOString(),
  };

  if (product.goods_type) {
    result.subtitle =
      product.goods_type.slice(0, 500);

    result.category_name =
      product.goods_type.slice(0, 200);
  }

  if (product.description) {
    result.short_desc =
      product.description.slice(0, 500);
  }

  if (product.image) {
    const image = product.image.trim();

    if (image) {
      let imageUrl = image;

      if (image.startsWith('/')) {
        imageUrl =
          `${getShopDomain()}${image}`;
      } else if (
        !/^https?:\/\//i.test(image)
      ) {
        imageUrl =
          `${getShopDomain()}/${image.replace(
            /^\/+/,
            '',
          )}`;
      }

      result.image_links = [
        imageUrl.slice(0, 1000),
      ];
    }
  }

  return result;
}

async function getAllProducts(): Promise<
  ProductRow[]
> {
  const { data, error } = await supabase
    .from('products')
    .select(`
      id,
      model,
      type,
      goods_type,
      color,
      body_material,
      handle_material,
      body_weight,
      package_weight,
      cartridge_size,
      cartridge_nut_material,
      left_handed_nut,
      hot_cold_output,
      package_dimensions,
      postal_hose,
      escutcheon,
      valve_material,
      spout_material,
      plator_material,
      hose_material,
      tags,
      price,
      description,
      image,
      created_at,
      brand,
      stock
    `)
    .order('created_at', {
      ascending: false,
    });

  if (error) {
    throw new Error(
      `Supabase products query failed: ${error.message}`,
    );
  }

  return (data || []) as ProductRow[];
}

async function getProductsByIds(
  ids: number[],
): Promise<ProductRow[]> {
  if (ids.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from('products')
    .select(`
      id,
      model,
      type,
      goods_type,
      color,
      body_material,
      handle_material,
      body_weight,
      package_weight,
      cartridge_size,
      cartridge_nut_material,
      left_handed_nut,
      hot_cold_output,
      package_dimensions,
      postal_hose,
      escutcheon,
      valve_material,
      spout_material,
      plator_material,
      hose_material,
      tags,
      price,
      description,
      image,
      created_at,
      brand,
      stock
    `)
    .in('id', ids);

  if (error) {
    throw new Error(
      `Supabase product lookup failed: ${error.message}`,
    );
  }

  return (data || []) as ProductRow[];
}

function sortProductsByIdOrder(
  products: ProductRow[],
  ids: number[],
): ProductRow[] {
  const map = new Map(
    products.map((product) => [
      product.id,
      product,
    ]),
  );

  return ids
    .map((id) => map.get(id))
    .filter(
      (
        product,
      ): product is ProductRow =>
        Boolean(product),
    );
}

function extractProductIdFromPageUrl(
  pageUrl: string,
): number | null {
  try {
    const url = new URL(pageUrl);

    if (
      url.origin !==
      new URL(getShopDomain()).origin
    ) {
      return null;
    }

    const match = url.hash.match(
      /^#\/product\/(\d+)\/?$/,
    );

    if (!match) {
      return null;
    }

    const id = Number(match[1]);

    if (
      !Number.isInteger(id) ||
      id <= 0
    ) {
      return null;
    }

    return id;
  } catch {
    return null;
  }
}

export async function handleTorobProducts(
  req: Request,
) {
  validateTorobJwt(req);

  const requestBody =
    validateRequestBody(req.body);

  /*
   * Request by page_urls
   *
   * Important:
   * We explicitly check !== undefined so TypeScript
   * can safely narrow the union type.
   */
  if (requestBody.page_urls !== undefined) {
    const ids = requestBody.page_urls
      .map(extractProductIdFromPageUrl)
      .filter(
        (id): id is number =>
          typeof id === 'number' &&
          Number.isInteger(id) &&
          id > 0,
      );

    const uniqueIds = [
      ...new Set(ids),
    ];

    const products =
      await getProductsByIds(uniqueIds);

    const orderedProducts =
      sortProductsByIdOrder(
        products,
        uniqueIds,
      );

    return {
      api_version: 'torob_api_v3',
      current_page: 1,
      total: orderedProducts.length,
      max_pages: 1,
      products:
        orderedProducts.map(mapProduct),
    };
  }

  /*
   * Request by page_uniques
   *
   * Important:
   * We explicitly check !== undefined so TypeScript
   * can safely narrow the union type.
   */
  if (
    requestBody.page_uniques !== undefined
  ) {
    const ids = requestBody.page_uniques
      .map((value) => Number(value))
      .filter(
        (id): id is number =>
          Number.isInteger(id) &&
          id > 0,
      );

    const uniqueIds = [
      ...new Set(ids),
    ];

    const products =
      await getProductsByIds(uniqueIds);

    const orderedProducts =
      sortProductsByIdOrder(
        products,
        uniqueIds,
      );

    return {
      api_version: 'torob_api_v3',
      current_page: 1,
      total: orderedProducts.length,
      max_pages: 1,
      products:
        orderedProducts.map(mapProduct),
    };
  }

  /*
   * Request by page
   *
   * At this point TypeScript knows that
   * requestBody is the third union member.
   */
  const products =
    await getAllProducts();

  const total = products.length;

  const maxPages = Math.max(
    1,
    Math.ceil(
      total / PAGE_SIZE,
    ),
  );

  const currentPage = Math.min(
    requestBody.page,
    maxPages,
  );

  const start =
    (currentPage - 1) *
    PAGE_SIZE;

  const pageProducts =
    products.slice(
      start,
      start + PAGE_SIZE,
    );

  return {
    api_version: 'torob_api_v3',
    current_page: currentPage,
    total,
    max_pages: maxPages,
    products:
      pageProducts.map(mapProduct),
  };
}