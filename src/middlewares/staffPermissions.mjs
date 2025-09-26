
export const requirePermission = (permission) => {
  return (req, res, next) => {
    const user = req.user; // from JWT
    console.log('User:', user);

    if (!user.permissions || !user.permissions[permission]) {
      return res.status(403).json({ 
        status: 'fail',
        message: 'Forbidden: insufficient privileges' 
      });
    }

    next();
  };
};
