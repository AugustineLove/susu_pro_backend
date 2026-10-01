// import bcrypt from 'bcrypt';

// const password = '1bigGod';

// const hash =
//   '$2b$10$WnnJtNAZ/fsxShQ5vF0ziOLcEfUAyJFEcGN0mcML1dRXkxQ3FmFSm';

// const isMatch = await bcrypt.compare(password, hash);

// console.log('MATCH:', isMatch);

import bcrypt from 'bcrypt';

const password = '1bigGod';

const hash = await bcrypt.hash(password, 10);

console.log(hash);