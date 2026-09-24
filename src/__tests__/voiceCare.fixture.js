// Fixture for the V5-VOICECARE-001 core (voiceCareResolve / voiceCareBatch tests).
//
// SHAPED LIKE THE REAL SETS, NOT INVENTED. The rows below are the ?view=picker population (U) as it
// stood on prod on 2026-09-23 — 244 plantings — reduced to the four fields the voice terms read
// (planting name, variety name, crop slug, crop search_aliases) plus the two the SERVER's scope
// resolver reads (status, location path). Every id is synthetic and deterministic; there are no user
// ids, and one planting label that carried a person's first name has been renamed. The location tree
// is the live 21-node tree from the same read.
//
// Why the real names rather than a hand-made handful: every hazard the design measured
// (`_roadmapexec_20260916/lane-G-voicecare-hostres.md` §1b, §2c–§2h) is a property of THIS vocabulary —
// "pasture in ground" hitting two locations by substring, Celebrity / Celebrity Rescue sharing a
// variety, "king" meaning King Richard in one area and King of the North in another, "cucumber one"
// landing on Cucamelon when the candidate list is narrowed to In-Ground. A synthetic garden built to
// exhibit those hazards would only prove that the test author could imagine them.
//
// The data is frozen. Live data will drift (Cantaloupe was live on 09-16 and is `ended` here), so
// these tests pin behaviour on this snapshot, not facts about the garden today.
//
// `status` and the location live in META, NOT on the U rows, on purpose: the real picker payload
// carries neither, so a resolver that read them off a U row would pass here and fail in the app. Only
// `dryRun` (the stand-in for POST /api/events/batch {dry_run:true}) reads META, exactly as only the
// server knows them.

import { splitCropAliases } from '../lib/comboboxInput.js'

const LOCATION_ROWS = [
  ['Deck', 0],
  ['Drive', 0],
  ['Drive > Drive-Shade', 1],
  ['Drive > Trough', 1],
  ['House', 0],
  ['Pasture', 0],
  ['Pasture > Bag Area', 1],
  ['Pasture > In-Ground', 1],
  ['Pasture > Legacy Pasture In-Ground', 1],
  ['Pasture > Pasture-Shade', 1],
  ['Stable', 0],
  ['Stable > Indoor Rack', 1],
  ['Stable > Indoor Rack > Shelf 1', 2],
  ['Stable > Indoor Rack > Shelf 2', 2],
  ['Stable > Indoor Rack > Shelf 3', 2],
  ['Stable > Indoor Rack > Shelf 4', 2],
  ['Stable > Indoor Rack > Shelf 5', 2],
  ['Yard', 0],
  ['Yard > Yard - Back', 1],
  ['Yard > Yard - Front', 1],
  ['Yard > Yard - Stable', 1],
]

// [planting name, variety name, crop slug, crop search_aliases, status, location full_path]
const ROWS = [
  ['1884', '1884', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Alaska Mix Nasturtium 1', 'Alaska Mix', 'nasturtium', '', 'vegetative', 'Drive > Trough'],
  ['Aloe Vera', 'Aloe Vera', 'aloe', '', 'vegetative', 'House'],
  ['Anaheim', 'Anaheim', 'pepper', '', 'harvested', 'Drive > Trough'],
  ['Ancho', 'Ancho', 'pepper', '', 'ended', 'Pasture > Bag Area'],
  ['Armageddon', 'Armageddon F1', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Arugula', 'Arugula', 'arugula', 'rocket', 'ended', 'Drive'],
  ['Atomic Red Carrot', 'Atomic Red', 'carrot', '', 'vegetative', 'Pasture > In-Ground'],
  ['Australe Butterhead Lettuce', 'Australe', 'lettuce', '', 'vegetative', 'Pasture > In-Ground'],
  ['Autumn Fire Stonecrop', 'Sedum spectabile', 'hylotelephium', 'showy stonecrop, stonecrop, sedum spectabile', 'vegetative', 'Stable'],
  ['Avocado', 'Avocado', 'avocado', '', 'vegetative', 'House'],
  ['Beets', 'Beet', 'beet', 'beetroot', 'ended', 'Pasture > Bag Area'],
  ['Belstar Broccoli', 'Belstar', 'broccoli', '', 'vegetative', 'Pasture > In-Ground'],
  ['Big Boy', 'Big Boy', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Bitter Melon', 'Bitter Melon', 'bitter_melon', 'bitter gourd, karela', 'harvested', 'Pasture > In-Ground'],
  ['Black Cherry', 'Black Cherry', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Black Olive', 'Black Olive', 'pepper', '', 'harvested', 'Drive > Drive-Shade'],
  ['Blackberry', 'Allegheny Blackberry', 'blackberry', '', 'dormant', 'Pasture > Legacy Pasture In-Ground'],
  ['Blueberries', 'High Bush', 'blueberry', '', 'dormant', 'Pasture > Legacy Pasture In-Ground'],
  ['Brentwood Leaf Lettuce', 'Brentwood', 'lettuce', '', 'vegetative', 'Pasture > In-Ground'],
  ['Broccoli', 'Broccoli', 'broccoli', '', 'ended', 'Pasture > Bag Area'],
  ['Bush Early Girl', 'Bush Early Girl', 'tomato', '', 'ended', 'Pasture > Bag Area'],
  ['Cabbage', 'Cabbage (unknown)', 'cabbage', '', 'fruiting', 'Pasture > Bag Area'],
  ['Cantaloupe', 'Cantaloupe', 'melon', 'cantaloupe, muskmelon, honeydew', 'ended', 'Pasture > In-Ground'],
  ['Capeliente', 'Capeliente', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Carmen', 'Carmen', 'pepper', '', 'ended', 'Pasture > Bag Area'],
  ['Cavendish Strawberry', 'Cavendish', 'strawberry', '', 'dormant', 'Stable'],
  ['Cayenne Blend', 'Cayenne Blend', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Celebrity', 'Celebrity', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Celebrity Rescue', 'Celebrity', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Charentais', 'Charentais', 'melon', 'cantaloupe, muskmelon, honeydew', 'ended', 'Pasture > In-Ground'],
  ['Cherokee Green', 'Cherokee Green', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Cherokee Green (Rescue)', 'Cherokee Green', 'tomato', '', 'fruiting', 'Pasture > Bag Area'],
  ['Cherry Falls', 'Cherry Falls', 'tomato', '', 'ended', 'Pasture > Bag Area'],
  ['Cherry Hot', 'Cherry Hot', 'pepper', '', 'fruiting', 'Pasture > Bag Area'],
  ['Cherry Rescue 1', 'Cherry', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Cherry Stuffer', 'Cherry Stuffer (Burpee)', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Chili Red', 'Chili Red', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Chilly Chill', 'Chilly Chill', 'pepper', '', 'harvested', 'Drive > Trough'],
  ['Chinese 5-Color', 'Chinese 5-Color', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Chives', 'Chives', 'chives', '', 'harvested', 'Pasture > Bag Area'],
  ['Chocolate Mint', 'Chocolate Mint', 'mint', '', 'vegetative', 'Pasture > Bag Area'],
  ['Christmas Cactus', 'Christmas Cactus', 'christmas_cactus', 'schlumbergera', 'dormant', 'Stable'],
  ['Chrysanthemum', 'Chrysanthemum', 'chrysanthemum', '', 'vegetative', 'Stable'],
  ['Cisneros', 'Cisneros', 'tomatillo', 'husk tomato', 'harvested', 'Pasture > Bag Area'],
  ['Citronella', 'Citronella Geranium', 'geranium', 'pelargonium', 'vegetative', 'Pasture > Bag Area'],
  ['Clemson Spineless 80', 'Clemson Spineless 80', 'okra', 'lady\'s finger, bhindi', 'fruiting', 'Pasture > In-Ground'],
  ['Cobaea scandens (Violet)', 'Cobaea scandens (Violet)', 'cobaea', '', 'vegetative', 'Drive > Trough'],
  ['Collards', 'Collards', 'collard', 'collard greens', 'vegetative', 'Pasture > Bag Area'],
  ['Combo Annuals', null, null, '', 'flowering', 'Drive > Trough'],
  ['Container Strawberry', 'Strawberry', 'strawberry', '', 'harvested', 'Drive > Trough'],
  ['Contender Bush Bean', 'Contender', 'bean', 'green bean, snap bean, string bean', 'harvested', 'Pasture > In-Ground'],
  ['Copenhagen Market Cabbage', 'Copenhagen Market', 'cabbage', '', 'vegetative', 'Pasture > Bag Area'],
  ['Copper Stonecrop', 'Golden Sedum', 'sedum', 'stonecrop', 'vegetative', 'Stable'],
  ['Cowhorn', 'Cowhorn', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Creme Sausage', 'Banana Creme', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Crimson Sweet', 'Crimson Sweet', 'watermelon', '', 'fruiting', 'Pasture > In-Ground'],
  ['Cubanelle', 'Cubanelle', 'pepper', '', 'ended', 'Pasture > Bag Area'],
  ['Cucamelon', 'Cucamelon', 'cucamelon', 'mouse melon, mexican sour gherkin', 'harvested', 'Pasture > In-Ground'],
  ['Czech\'s Bush', 'Czech\'s Bush', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Danvers 126 Carrot', 'Danvers 126', 'carrot', '', 'vegetative', 'Pasture > In-Ground'],
  ['Dark Green Zucchini', 'Dark Green Zucchini', 'squash', 'zucchini, courgette', 'ended', 'Pasture > Bag Area'],
  ['Del Tonet', 'Del Tonet', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Delicious', 'Delicious', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Dester', 'Dester', 'tomato', '', 'ended', 'Pasture > Bag Area'],
  ['Dill', 'Dill \'Bouquet\'', 'dill', '', 'harvested', 'Pasture > Bag Area'],
  ['Dragon Roll', 'Dragon Roll', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Dwarf Blue Curled Kale', 'Dwarf Blue Curled (Vates)', 'kale', '', 'vegetative', 'Pasture > Bag Area'],
  ['Easy Wave Berry Velour Petunia', 'Easy Wave Berry Velour', 'petunia', '', 'flowering', 'Drive > Trough'],
  ['Echeveria', 'Echeveria', 'echeveria', '', 'vegetative', 'Stable'],
  ['Echeveria \'Perle von Nurnberg\'', 'Echeveria \'Perle von Nurnberg\'', 'echeveria', '', 'vegetative', 'Stable'],
  ['Edible Beauties', 'Edible Beauties', 'flower_mix', '', 'vegetative', 'Drive > Trough'],
  ['Eva Purple Ball', 'Eva Purple Ball', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Fairway Orange Coleus', 'Fairway Orange', 'coleus', 'plectranthus', 'vegetative', 'Drive > Trough'],
  ['Fairway Orange Coleus Clone 1', 'Fairway Orange', 'coleus', 'plectranthus', 'vegetative', 'Drive > Drive-Shade'],
  ['Fantasia Salmon Geranium', 'Fantasia Salmon', 'geranium', 'pelargonium', 'vegetative', 'Drive > Trough'],
  ['Fingerling Potatoes', 'Fingerling', 'potato', '', 'ended', 'Pasture > Bag Area'],
  ['Flat of Italy Bulb Cipollini Onion', 'Flat of Italy', 'onion', '', 'vegetative', 'Pasture > In-Ground'],
  ['Floradade', 'Floradade', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Foxglove', 'Foxglove', 'foxglove', 'digitalis', 'vegetative', 'Drive > Drive-Shade'],
  ['French Tarragon', 'French Tarragon', 'tarragon', '', 'vegetative', 'Pasture > Bag Area'],
  ['Garden Sage', 'Garden Sage', 'sage', 'salvia', 'vegetative', 'Pasture > Bag Area'],
  ['Garlic', 'Garlic (hardneck)', 'garlic', '', 'ended', 'Pasture > Legacy Pasture In-Ground'],
  ['Garlic Chives', 'Garlic Chives', 'chives', '', 'harvested', 'Pasture > Bag Area'],
  ['Gatherer\'s Gold', 'Gatherer\'s Gold', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Geranium Cutting', 'Geranium', 'geranium', 'pelargonium', 'flowering', 'Stable'],
  ['Fuchsia Geranium', 'Geranium', 'geranium', 'pelargonium', 'flowering', 'Stable'],
  ['Ghost', 'Ghost', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Ginger', 'Ginger', 'ginger', '', 'vegetative', 'Stable'],
  ['Gold Rush Bush Bean', 'Gold Rush', 'bean', 'green bean, snap bean, string bean', 'harvested', 'Pasture > In-Ground'],
  ['Golden Sedum', 'Golden Sedum', 'sedum', 'stonecrop', 'vegetative', 'Stable'],
  ['Goldenrod', 'Canada', 'goldenrod', '', 'vegetative', 'Drive > Trough'],
  ['Gong Bao', 'Gong Bao (Kung Pao)', 'pepper', '', 'harvested', 'Drive > Trough'],
  ['Gourmet Blend Beets', 'Gourmet Blend', 'beet', 'beetroot', 'vegetative', 'Pasture > Bag Area'],
  ['Granadero', 'Granadero', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Graptosedum', 'Graptosedum', 'succulent', '', 'vegetative', 'Stable'],
  ['Greek Oregano', 'Greek Oregano', 'oregano', '', 'vegetative', 'Deck'],
  ['Green Fittonia', 'Green Fittonia', 'fittonia', 'nerve plant', 'vegetative', 'House'],
  ['Green Flesh', 'Green Flesh', 'melon', 'cantaloupe, muskmelon, honeydew', 'ended', 'Pasture > In-Ground'],
  ['Green Magic', 'Green Magic', 'broccoli', '', 'ended', 'Pasture > Bag Area'],
  ['Gymnocalycium mihanovichii', 'Gymnocalycium mihanovichii', 'cactus', '', 'vegetative', 'Stable'],
  ['Habanero', 'Habanero', 'pepper', '', 'harvested', 'Drive'],
  ['Haworthia / Gasteria (assorted)', 'Haworthia / Gasteria (assorted)', 'haworthia', '', 'vegetative', 'Stable'],
  ['Holy Basil', 'Holy Basil (Tulsi)', 'basil', '', 'harvested', 'Pasture > Bag Area'],
  ['Horseweed', 'Horseweed', 'horseweed', '', 'flowering', 'Stable'],
  ['Hosta', 'Hosta', 'hosta', '', 'vegetative', 'Yard > Yard - Stable'],
  ['Hot & Spicy Oregano', 'Hot & Spicy Oregano', 'oregano', '', 'harvested', 'Pasture > Bag Area'],
  ['Hoya Obovata', 'Hoya', 'hoya', '', 'vegetative', 'House'],
  ['Hydrangeas', null, null, '', 'flowering', 'Pasture'],
  ['Italian Parsley', 'Italian Parsley', 'parsley', '', 'vegetative', 'Stable'],
  ['Jade Plant', 'Crassula ovata', 'jade', '', 'vegetative', 'House'],
  ['Jalapeno', 'Jalapeno', 'pepper', '', 'fruiting', 'Drive > Trough'],
  ['Japanese Maple', 'Japanese Maple', 'japanese_maple', 'acer', 'vegetative', 'Drive'],
  ['Jaune du Poitou', 'Jaune du Poitou', 'leek', '', 'vegetative', 'Pasture > In-Ground'],
  ['Jet Star', 'Jet Star', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Jewel Mix Nasturtium', 'Jewel Mix Nasturtium', 'nasturtium', '', 'flowering', 'Pasture > Bag Area'],
  ['King of the North', 'King of the North', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['King Richard', 'King Richard', 'leek', '', 'vegetative', 'Pasture > In-Ground'],
  ['Kiwi Fern Coleus', 'Kiwi Fern', 'coleus', 'plectranthus', 'vegetative', 'Drive > Trough'],
  ['Kori Sitakame', 'Kori Sitakame', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Kousa Dogwood', 'Kousa', 'dogwood', 'cornus', 'dormant', 'Drive'],
  ['Lacinato Dinosaur Kale', 'Lacinato (Dinosaur)', 'kale', '', 'vegetative', 'Pasture > Bag Area'],
  ['Lamb\'s Ear', 'Lamb\'s Ear', 'lamb_s_ear', '', 'vegetative', 'Drive'],
  ['Lantana', 'Lantana', 'lantana', '', 'flowering', 'Drive > Trough'],
  ['Large Red Cherry', 'Large Red Cherry', 'tomato', '', 'harvested', 'Drive > Drive-Shade'],
  ['Lemon Thyme', 'Lemon Thyme', 'thyme', '', 'vegetative', 'Drive > Drive-Shade'],
  ['Lemon Verbena', 'Lemon Verbena', 'lemon_verbena', 'aloysia', 'harvested', 'Pasture > Bag Area'],
  ['Lemongrass', 'Lemongrass', 'lemongrass', '', 'ended', 'Pasture > Bag Area'],
  ['Lettuce Leaf Basil', 'Lettuce Leaf Basil', 'basil', '', 'harvested', 'Pasture > Bag Area'],
  ['Little Gem Mini-Romaine Lettuce', 'Little Gem', 'lettuce', '', 'vegetative', 'Pasture > In-Ground'],
  ['Love\'s Fire', 'Love\'s Fire', 'succulent', '', 'vegetative', 'Stable'],
  ['Mahogany Splendor Hybiscus', 'Mahogany Splendor', 'hibiscus', '', 'vegetative', 'Drive > Trough'],
  ['Mammoth Dill', 'Mammoth', 'dill', '', 'harvested', 'Pasture > Bag Area'],
  ['Manitoba', 'Manitoba', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Margaret Curtain', 'Margaret Curtain', 'tomato', '', 'ended', 'Pasture > Bag Area'],
  ['Marigolds', 'Marigolds', 'marigold', '', 'flowering', 'Pasture > Bag Area'],
  ['Marvel of Four Seasons Butterhead Lettuce', 'Marvel of Four Seasons', 'lettuce', '', 'vegetative', 'Pasture > In-Ground'],
  ['Megatron Jalapeños', 'Megatron F1 (jumbo jalapeno)', 'pepper', '', 'fruiting', 'Pasture > Bag Area'],
  ['Mini Rose', 'Mini Rose', 'rose', '', 'vegetative', 'Drive > Trough'],
  ['Minnesota Mini', 'Minnesota Mini', 'melon', 'cantaloupe, muskmelon, honeydew', 'ended', 'Pasture > In-Ground'],
  ['Moskvich Heirloom', 'Moskvich Heirloom', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Mountain Fresh Plus', 'Mountain Fresh Plus', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Neon Pothos', 'Neon', 'pothos', 'devil\'s ivy, epipremnum', 'vegetative', 'House'],
  ['Neon Rose Calibrachoa', 'Neon Rose', 'calibrachoa', 'million bells', 'vegetative', 'Drive > Trough'],
  ['New Mexico', 'New Mexico (Hatch-type)', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['New Yorker', 'New Yorker', 'tomato', '', 'ended', 'Pasture > Bag Area'],
  ['Onion — scallion-type (thick blue-green, ID pending)', 'Onion (scallion-type)', 'bunching_onion', '', 'vegetative', 'Deck'],
  ['Oregano', 'Oregano', 'oregano', '', 'vegetative', 'Deck'],
  ['Oregon Spring', 'Oregon Spring', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Pachyphytum', 'Pachyphytum', 'succulent', '', 'vegetative', 'Stable'],
  ['Palla Rossa Mavrik Radicchio', 'Palla Rossa Mavrik', 'radicchio', '', 'vegetative', 'Pasture > Bag Area'],
  ['Parris Island Cos Romaine Lettuce', 'Parris Island Cos', 'lettuce', '', 'vegetative', 'Pasture > In-Ground'],
  ['Peach tree', 'Peach', 'peach', '', 'harvested', 'Pasture > Legacy Pasture In-Ground'],
  ['Penstemon', 'Penstemon', 'penstemon', 'beardtongue', 'flowering', 'Drive > Trough'],
  ['Peppermint', 'Peppermint', 'mint', '', 'vegetative', 'Pasture > Bag Area'],
  ['Petunia', 'Petunia', 'petunia', '', 'flowering', 'Drive > Trough'],
  ['Pick and Pop', 'Pick-N-Pop Yellow', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Pineapple Sage', 'Pineapple Sage', 'pineapple_sage', 'salvia, salvia elegans', 'vegetative', 'Pasture > Bag Area'],
  ['Pineapple Tomatillo', 'Pineapple Tomatillo', 'tomatillo', 'husk tomato', 'harvested', 'Pasture > Bag Area'],
  ['Pineapple Tomato', 'Pineapple Tomato', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Ping Tung Long', 'Ping Tung Long', 'eggplant', 'aubergine', 'harvested', 'Pasture > Bag Area'],
  ['Pink Fittonia', 'Pink Fittonia', 'fittonia', 'nerve plant', 'vegetative', 'House'],
  ['Pinto Premium White Geranium', 'Pinto Premium White', 'geranium', 'pelargonium', 'vegetative', 'Drive > Trough'],
  ['Piri Piri', 'Piri Piri', 'pepper', '', 'harvested', 'Drive > Trough'],
  ['Pothos', 'Golden Pothos', 'pothos', 'devil\'s ivy, epipremnum', 'vegetative', 'House'],
  ['Pumpkin Jalapeno', 'Pumpkin Jalapeno', 'pepper', '', 'harvested', 'Drive > Trough'],
  ['Purple Basil', 'Purple Basil', 'basil', '', 'harvested', 'Pasture > Bag Area'],
  ['Purple Blush Tomatillo', 'Purple blush', 'tomatillo', 'husk tomato', 'harvested', 'Pasture > Bag Area'],
  ['Purple Heart', 'Purpurea', 'tradescantia', 'spiderwort, inch plant', 'vegetative', 'House'],
  ['Purple Petra', 'Purple Petra Basil', 'basil', '', 'harvested', 'Pasture > Bag Area'],
  ['Purple Vienna Kohlrabi', 'Purple Vienna', 'kohlrabi', 'german turnip', 'vegetative', 'Pasture > In-Ground'],
  ['Quadrato Rossi', 'Quadrato d\'Asti Rosso', 'pepper', '', 'fruiting', 'Drive > Trough'],
  ['Rapini Broccoli Raab', 'Rapini', 'broccoli', '', 'vegetative', 'Pasture > Bag Area'],
  ['Red Acre Cabbage', 'Red Acre', 'cabbage', '', 'vegetative', 'Pasture > Bag Area'],
  ['Red Fittonia', 'Red Fittonia', 'fittonia', 'nerve plant', 'vegetative', 'House'],
  ['Red Grape', 'Red Grape', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Red Mini Bell', 'Red Mini Bell', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Red Onions', 'Red Onion (long-day)', 'onion', '', 'ended', 'Pasture > Bag Area'],
  ['Red Raspberries', 'Red Raspberry', 'red_raspberry', '', 'dormant', 'Pasture > Legacy Pasture In-Ground'],
  ['Red Rose (cultivar unknown)', 'Red Rose', 'rose', '', 'vegetative', 'Drive'],
  ['Redbor Kale', 'Redbor', 'kale', '', 'vegetative', 'Pasture > Bag Area'],
  ['Ristra Cayenne II', 'Ristra Cayenne II', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Rosemary', 'Rosemary', 'rosemary', '', 'vegetative', 'Drive > Drive-Shade'],
  ['Rosso Sicilian', 'Rosa Sicilian', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Royal Ruby Hens & Chicks', 'Royal Ruby', 'sempervivum', '', 'vegetative', 'Stable'],
  ['Russet Potato', 'Russet', 'potato', '', 'ended', 'Pasture > Bag Area'],
  ['Russian Tarragon', 'Russian Tarragon', 'tarragon', '', 'vegetative', 'Pasture > Bag Area'],
  ['San Marzano rescue', 'San Marzano', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['San Marzano Roma', 'San Marzano Roma', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Santa Fe Grande', 'Santa Fe Grande', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Scallion (thin clump)', 'Scallion', 'bunching_onion', '', 'vegetative', 'Deck'],
  ['Scotch Bonnet', 'Scotch Bonnet', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Serranos', 'Serrano', 'pepper', '', 'harvested', 'Drive > Trough'],
  ['Shallots', 'Shallots', 'shallot', '', 'harvested', 'Pasture > In-Ground'],
  ['Silver Helichrysum', 'Silver (Licorice Plant)', 'helichrysum', '', 'vegetative', 'Drive > Trough'],
  ['Speckled Roman', 'Speckled Roman', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Speckled Roman Rescue', 'Speckled Roman', 'tomato', '', 'fruiting', 'Pasture > Bag Area'],
  ['Spider Plant', 'Spider Plant', 'spider_plant', 'chlorophytum', 'vegetative', 'Stable'],
  ['Strawberries', 'Early June', 'strawberry', '', 'dormant', 'Pasture > Bag Area'],
  ['Stupice', 'Stupice', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Sub Arctic Plenty', 'Sub Arctic Plenty', 'tomato', '', 'ended', 'Pasture > Bag Area'],
  ['Sugar Baby', 'Sugar Baby', 'watermelon', '', 'harvested', 'Pasture > In-Ground'],
  ['Sugar Rush Peach', 'Sugar Rush Peach', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Summer Pastels Yarrow', 'Summer Pastels', 'yarrow', 'achillea', 'vegetative', 'Drive'],
  ['Sun Sugar', 'Sun Sugar', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Sunny Susy White Halo Thunbergia', 'Sunny Susy White Halo', 'thunbergia', 'black-eyed susan vine', 'flowering', 'Drive > Trough'],
  ['Sunray', 'Sunray', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Super Sweet 100', 'Super Sweet 100', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Super Sweet 100 Rescue', 'Super Sweet 100', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Suyo Long', 'Suyo Long', 'cucumber', '', 'harvested', 'Pasture > Bag Area'],
  ['Sweet Basil', 'Ocimum basilicum \'Sweet\'', 'basil', '', 'harvested', 'Pasture > Bag Area'],
  ['Sweet Bay Laurel', 'Sweet Bay', 'bay', 'bay laurel', 'vegetative', 'Drive > Trough'],
  ['Sweet Potato', 'Sweet Potato', 'sweet_potato', '', 'ended', 'Drive > Drive-Shade'],
  ['Sweet Potatoes', 'Sweet Potato', 'sweet_potato', '', 'ended', 'Pasture > Bag Area'],
  ['Tatli Kil Sivri', 'Sweet Sivri', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Tavera Filet Bush Bean', 'Tavera', 'bean', 'green bean, snap bean, string bean', 'harvested', 'Pasture > In-Ground'],
  ['Tender Sweet Orange', 'Tender Sweet Orange', 'watermelon', '', 'harvested', 'Pasture > In-Ground'],
  ['Tendersweet Carrot', 'Tendersweet', 'carrot', '', 'vegetative', 'Pasture > In-Ground'],
  ['Thai Basil', 'Thai Basil', 'basil', '', 'harvested', 'Pasture > Bag Area'],
  ['Thai Dragon', 'Thai Dragon', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Thessaloniki', 'Thessaloniki', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Tie-Dye Tomato', 'Tie-Dye', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Tradescantia', 'Tradescantia zebrina', 'tradescantia', 'spiderwort, inch plant', 'vegetative', 'Stable'],
  ['Tradescantia Cuttings Experiment.', 'Tradescantia', 'tradescantia', 'spiderwort, inch plant', 'vegetative', 'Stable'],
  ['Tres Fine', 'Tres Fine', 'endive', '', 'ended', 'Drive'],
  ['Tuberous Begonia (bronze-leaf, hanging)', 'Tuberous Begonia', 'begonia', '', 'flowering', 'Deck'],
  ['Tulsi Basil', 'Holy Basil (Tulsi)', 'basil', '', 'harvested', 'Pasture > Bag Area'],
  ['Tumeric', null, null, '', 'vegetative', 'House'],
  ['Ukrainian Purple', 'Ukrainian Purple', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Unknown Bell', 'Bell Pepper (Unknown)', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Unknown Sweet Long', 'Unknown Sweet Long', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Unknown Sweet Orange', 'Sweet Orange Pepper (Unknown)', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Unknown Tomato Cuttings', 'Unknown', 'tomato', '', 'ended', 'Drive'],
  ['Valencia', 'Valencia', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Wild Bergamot', 'Wild Bergamot', 'bee_balm', 'monarda, bergamot', 'dormant', 'Pasture > Legacy Pasture In-Ground'],
  ['Wild Wineberry', 'Wild Wineberry', 'wineberry', '', 'dormant', 'Pasture > Pasture-Shade'],
  ['Wishbone Flower (Torenia)', 'Wishbone Flower', 'torenia', '', 'flowering', 'Drive > Trough'],
  ['Yatsufusa', 'Yatsufusa', 'pepper', '', 'harvested', 'Pasture > Bag Area'],
  ['Yellow Brandywine', 'Yellow Brandywine', 'tomato', '', 'ended', 'Pasture > Bag Area'],
  ['Yellow Onions', 'Yellow Onion (long-day)', 'onion', '', 'ended', 'Pasture > Bag Area'],
  ['Yellow Pear', 'Yellow Pear', 'tomato', '', 'harvested', 'Pasture > Bag Area'],
  ['Yukon Gold', 'Yukon Gold', 'potato', '', 'ended', 'Stable'],
  ['Zephyr Squash', 'Zephyr', 'squash', 'zucchini, courgette', 'harvested', 'Pasture > In-Ground'],
  ['Zonal Geranium', 'Zonal Geranium', 'geranium', 'pelargonium', 'flowering', 'Drive > Trough'],
]

const hex = (n, width = 12) => n.toString(16).padStart(width, '0')

export const LOCATIONS = (() => {
  const byPath = new Map()
  const out = LOCATION_ROWS.map(([fullPath, level], i) => {
    const parts = fullPath.split(' > ')
    const loc = {
      id: `00000000-0000-4000-a000-${hex(i + 1)}`,
      name: parts[parts.length - 1],
      full_path: fullPath,
      level,
      parent_id: null,
    }
    byPath.set(fullPath, loc)
    return loc
  })
  for (const loc of out) {
    const parts = loc.full_path.split(' > ')
    if (parts.length > 1) loc.parent_id = byPath.get(parts.slice(0, -1).join(' > ')).id
  }
  return out
})()

export const locationByPath = (p) => {
  const loc = LOCATIONS.find((l) => l.full_path === p)
  if (!loc) throw new Error(`fixture has no location ${p}`)
  return loc
}

const varietyIds = new Map()
const varietyIdOf = (name) => {
  if (!varietyIds.has(name)) varietyIds.set(name, `00000000-0000-4000-9000-${hex(varietyIds.size + 1)}`)
  return varietyIds.get(name)
}

const META = new Map()

// The picker row shape (lambda/plants/index.js ?view=picker, trimmed to the fields any voice layer
// reads) with `crop_aliases` attached ONLY when non-empty — exactly as VoiceHarvest.jsx attaches it.
export const U = ROWS.map(([name, variety, crop, aliases, status, locPath], i) => {
  const id = `00000000-0000-4000-8000-${hex(i + 1)}`
  META.set(id, { status, locationId: locPath ? locationByPath(locPath).id : null })
  const variety_ref = variety == null ? null : { id: varietyIdOf(variety), name: variety, crop_type_slug: crop }
  const row = { id, name, variety_id: variety_ref?.id ?? null, variety_ref }
  const cropAliases = splitCropAliases(aliases)
  return cropAliases.length ? { ...row, crop_aliases: cropAliases } : row
})

export const byName = (name) => {
  const hits = U.filter((p) => p.name === name)
  if (hits.length !== 1) throw new Error(`fixture: ${hits.length} plantings named ${name}`)
  return hits[0]
}

export const statusOf = (id) => META.get(id)?.status

// The LIVE-planting triple the batch resolver applies (lambda/events/index.js, the `resolved` SELECT):
// status NOT IN ('failed','ended','dormant'), over the location's whole subtree, ordered by name.
const DEAD = new Set(['failed', 'ended', 'dormant'])
const subtree = (locationId) => {
  const ids = new Set([locationId])
  let grew = true
  while (grew) {
    grew = false
    for (const l of LOCATIONS) {
      if (l.parent_id && ids.has(l.parent_id) && !ids.has(l.id)) { ids.add(l.id); grew = true }
    }
  }
  return ids
}

// Stand-in for POST /api/events/batch {dry_run:true, scope:{type:'space', location_id}}, returned in
// the shape fetchCareScopeSet hands the resolver.
export function dryRun(locationId, { cap = 500 } = {}) {
  const locs = subtree(locationId)
  const live = U.filter((p) => {
    const m = META.get(p.id)
    return m.locationId && locs.has(m.locationId) && !DEAD.has(m.status)
  }).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  const kept = live.slice(0, cap)
  return {
    locationId,
    count: kept.length,
    capped: live.length > cap,
    plantings: kept.map((p) => ({
      id: p.id, name: p.name, crop_type_slug: p.variety_ref?.crop_type_slug ?? null,
      location_id: META.get(p.id).locationId,
    })),
  }
}

// The raw server response for the same dry run, for the client-module tests.
export function dryRunResponse(locationId, opts) {
  const { count, capped, plantings } = dryRun(locationId, opts)
  return { count, capped, plantings }
}
